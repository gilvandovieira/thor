/**
 * Hot-path overhead benchmark + staged CI gate (spec §19.3, Epics I2/I3, W3).
 *
 * Measures Thor's own overhead (no I/O — a constant driver + shared runtime)
 * across the axes that the perf work targets:
 *   - cold      : query rebuilt every call (compile + guard run each time)
 *   - warm      : stable IR reused → compile/guard memoized (W3 target path)
 *   - prepared  : `.prepare()` handle → precompiled decoder + per-dialect compile (I3)
 *   - decode    : bulk read in `safe` vs `unsafe` mode → decode-skip win (Epic E)
 *
 *   pnpm bench:hotpath            # print results
 *   BENCH_GATE=1 pnpm bench:hotpath   # compare to baseline, fail on catastrophic regression
 *   BENCH_UPDATE_BASELINE=1 ...   # (re)record the baseline
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Database, count, db, eq, param, pg, withMode } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { defineFunction } from "@gilvandovieira/thor/routine"
import {
  formatDuration,
  formatRange,
  formatThroughput,
  measureSync,
  assessBenchmarkTarget,
  noiseLabel,
  percentFaster,
  runtimeName,
  timingLegend,
  type Timing
} from "./bench-report.mts"

const users = pg.table("bench_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable(),
  age: pg.integer("age").nullable()
})
const posts = pg.table("bench_posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  userId: pg.uuid("user_id").notNull()
})
const emailParam = param("email", Schema.String)
const lowerRoutine = defineFunction("lower", {
  args: [{ dataType: "text", codec: Schema.String }],
  returns: { dataType: "text", codec: Schema.String },
  volatility: "immutable"
})

/** Constant, zero-I/O driver returning fixed rows synchronously. */
const layerFor = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: {
      query: () => Effect.succeed(rows),
      execute: () => Effect.succeed({ rowCount: rows.length }),
      executeScript: () => Effect.succeed({ rowCount: 0 })
    },
    allowEmulation: false,
    preparedStatements: true
  } as never)

const pointRows = [{ id: "018f0000-0000-7000-8000-000000000001", name: "Ada" }]
const bulkRows = Array.from({ length: 100 }, (_, i) => ({
  id: "018f0000-0000-7000-8000-0000000000" + String(i).padStart(2, "0"),
  email: `u${i}@b.c`,
  name: i % 2 ? null : `n${i}`,
  age: i
}))

const pointRt = ManagedRuntime.make(layerFor(pointRows))
const bulkLayer = layerFor(bulkRows)
const bulkRt = ManagedRuntime.make(bulkLayer)
const bulkUnsafeRt = ManagedRuntime.make(withMode(bulkLayer, "unsafe"))
const advancedRt = ManagedRuntime.make(layerFor([{ email: "a@b.c", total: 1 }]))
const routineRt = ManagedRuntime.make(layerFor([{ lowered: "a@b.c" }]))

const pointQuery = () => db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, emailParam))
const warmPoint = pointQuery()
const preparedPoint = warmPoint.prepare("point")
const bulkQuery = db.select({ id: users.id, email: users.email, name: users.name, age: users.age }).from(users)
const advancedQuery = db
  .select({ email: users.email, total: count() })
  .from(users)
  .leftJoin(posts, eq(users.id, posts.userId))
  .groupBy(users.email)
  .prepare("advanced-aggregate")
const routineQuery = db
  .select({ lowered: lowerRoutine(users.email) })
  .from(users)
  .prepare("routine-lower")

interface Sample extends Timing {
  readonly label: string
  readonly description: string
}
const time = (label: string, description: string, iters: number, fn: () => void): Sample => ({
  label,
  description,
  ...measureSync({ iterationsPerSample: Math.ceil(iters / 5), warmupIterations: 2_000 }, fn)
})

const samples: Sample[] = [
  time("point.cold", "rebuild the query every time", 100_000, () =>
    void pointRt.runSync(pointQuery().one({ email: "a@b.c" }))
  ),
  time("point.warm", "reuse the same query", 100_000, () => void pointRt.runSync(warmPoint.one({ email: "a@b.c" }))),
  time("point.prepared", "reuse a prepared handle", 100_000, () =>
    void pointRt.runSync(preparedPoint.one({ email: "a@b.c" }))
  ),
  time("advanced.prepared", "join + group through a handle", 100_000, () => void advancedRt.runSync(advancedQuery.all())),
  time("routine.prepared", "declared routine through a handle", 100_000, () => void routineRt.runSync(routineQuery.all())),
  time("bulk.safe", "read and check 100 rows", 20_000, () => void bulkRt.runSync(bulkQuery.all())),
  time("bulk.unsafe", "read 100 rows without checks", 20_000, () => void bulkUnsafeRt.runSync(bulkQuery.all()))
]

const by = Object.fromEntries(samples.map((s) => [s.label, s.nsPerOp]))
const repeatedSavingsNs = (slowerNs: number, fasterNs: number, operations = 100_000) =>
  (slowerNs - fasterNs) * operations
const targets = {
  "point.warm": assessBenchmarkTarget(by["point.warm"]!, 2_000),
  "point.prepared": assessBenchmarkTarget(by["point.prepared"]!, 1_000)
} as const

console.log("\nThor hot-path overhead — Thor's cost only, with no database or network\n" + "-".repeat(100))
console.log(timingLegend(samples[0]!.sampleCount))
console.log("Throughput is an equivalent for comparison, not promised production capacity.\n")
console.log(
  `  ${"path".padEnd(20)} ${"what it does".padEnd(35)} ${"typical".padStart(10)} ${"range".padStart(19)} ${"equivalent".padStart(17)}  consistency`
)
for (const s of samples) {
  console.log(
    `  ${s.label.padEnd(20)} ${s.description.padEnd(35)} ${formatDuration(s.nsPerOp).padStart(10)} ${formatRange(s).padStart(19)} ${formatThroughput(s.opsPerSec).padStart(17)}  ${noiseLabel(s)}`
  )
}

console.log("\nIn everyday terms:")
console.log(
  `  • Reusing a query removes ${percentFaster(by["point.cold"]!, by["point.warm"]!).toFixed(0)}% of Thor's work and saves about ${formatDuration(repeatedSavingsNs(by["point.cold"]!, by["point.warm"]!))} over 100,000 calls.`
)
console.log(
  `  • A prepared handle removes another ${percentFaster(by["point.warm"]!, by["point.prepared"]!).toFixed(0)}% versus ordinary reuse.`
)
console.log(
  `  • Checking 100 returned rows costs ${formatDuration(by["bulk.safe"]! - by["bulk.unsafe"]!)} here; unsafe mode skips those checks and is opt-in.`
)
console.log(
  `  • Warm cached target (≤ 2 µs): ${targets["point.warm"].status.toUpperCase()} at ${formatDuration(targets["point.warm"].valueNs)} (${targets["point.warm"].ratio.toFixed(2)}× target).`
)
console.log(
  `  • Smallest prepared-path ideal boundary (≤ 1 µs): ${targets["point.prepared"].status.toUpperCase()} at ${formatDuration(targets["point.prepared"].valueNs)}.`
)
console.log(`\nJSON:${JSON.stringify({ runtime: runtimeName(), metrics: by, targets })}`)

await pointRt.dispose()
await bulkRt.dispose()
await bulkUnsafeRt.dispose()
await advancedRt.dispose()
await routineRt.dispose()

// --- staged CI gate (spec §15.16) -------------------------------------------
if (process.env.BENCH_GATE || process.env.BENCH_UPDATE_BASELINE) {
  const runtime = runtimeName()
  const baselineFile = `${runtime}-${process.platform}-${process.arch}.json`
  const baselinePath = fileURLToPath(new URL(`./hotpath-baselines/${baselineFile}`, import.meta.url))
  const THRESHOLD = 2.5 // generous: fail only on catastrophic regression while baselines stabilize
  const environment = {
    runtime,
    version: runtime === "node" ? process.versions.node : process.versions.bun ?? "unknown",
    platform: process.platform,
    architecture: process.arch
  }

  interface Baseline {
    readonly schemaVersion: 1
    readonly environment: typeof environment
    readonly measurement: {
      readonly statistic: "median"
      readonly samples: number
    }
    readonly metrics: Record<string, number>
  }

  if (process.env.BENCH_UPDATE_BASELINE) {
    mkdirSync(dirname(baselinePath), { recursive: true })
    const metrics = Object.fromEntries(samples.map((sample) => [sample.label, Math.round(sample.nsPerOp)]))
    const baseline: Baseline = {
      schemaVersion: 1,
      environment,
      measurement: { statistic: "median", samples: samples[0]!.sampleCount },
      metrics
    }
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n")
    console.log(`\n[gate] baseline recorded → ${baselinePath}`)
  } else if (!existsSync(baselinePath)) {
    console.error(`\n[gate] FAIL — required baseline is missing: ${baselinePath}`)
    console.error("[gate] Record and review it deliberately with `pnpm bench:baseline`; the gate will never baseline itself.")
    process.exit(1)
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline
    if (baseline.schemaVersion !== 1 || !baseline.metrics) {
      console.error(`\n[gate] FAIL — unsupported baseline format: ${baselinePath}`)
      process.exit(1)
    }
    const missing = samples.filter((s) => baseline.metrics[s.label] === undefined).map((s) => s.label)
    if (missing.length > 0) {
      console.error(`\n[gate] FAIL — baseline is missing metrics: ${missing.join(", ")}`)
      console.error("[gate] Update it deliberately with `pnpm bench:baseline` and review the changed numbers.")
      process.exit(1)
    }
    const regressions = samples
      .filter((s) => s.nsPerOp > baseline.metrics[s.label]! * THRESHOLD)
      .map(
        (s) =>
          `${s.label}: ${formatDuration(s.nsPerOp)} now vs ${formatDuration(baseline.metrics[s.label]!)} baseline (${(s.nsPerOp / baseline.metrics[s.label]!).toFixed(2)}× slower)`
      )
    if (regressions.length > 0) {
      console.error(`\n[gate] FAIL — catastrophic regression:\n  ${regressions.join("\n  ")}`)
      process.exit(1)
    }
    console.log(`\n[gate] OK — no metric is ${THRESHOLD}× slower than the reviewed ${baselineFile} baseline.`)
    console.log("[gate] This is a catastrophic-regression guardrail, not proof that small changes are harmless.")
  }
}
