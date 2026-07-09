/**
 * Hot-path overhead benchmark + staged CI gate (spec §15.12, §15.16, Epics I2/I3).
 *
 * Measures Thor's own overhead (no I/O — a constant driver + shared runtime)
 * across the axes that the perf work targets:
 *   - cold      : query rebuilt every call (compile + guard run each time)
 *   - warm      : stable IR reused → compile/guard memoized (cache hit, I2)
 *   - prepared  : `.prepare()` handle → precompiled decoder + per-dialect compile (I3)
 *   - decode    : bulk read in `safe` vs `unsafe` mode → decode-skip win (Epic E)
 *
 *   pnpm bench:hotpath            # print results
 *   BENCH_GATE=1 pnpm bench:hotpath   # compare to baseline, fail on catastrophic regression
 *   BENCH_UPDATE_BASELINE=1 ...   # (re)record the baseline
 */
import { performance } from "node:perf_hooks"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Database, db, eq, param, pg, withMode } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"

const users = pg.table("bench_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable(),
  age: pg.integer("age").nullable()
})
const emailParam = param("email", Schema.String)

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

const pointQuery = () => db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, emailParam))
const warmPoint = pointQuery()
const preparedPoint = warmPoint.prepare("point")
const bulkQuery = db.select({ id: users.id, email: users.email, name: users.name, age: users.age }).from(users)

interface Sample {
  readonly label: string
  readonly nsPerOp: number
}
const time = (label: string, iters: number, fn: () => void): Sample => {
  for (let i = 0; i < Math.min(iters, 3000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return { label, nsPerOp: ((performance.now() - start) * 1e6) / iters }
}

const samples: Sample[] = [
  time("point.cold", 100_000, () => void pointRt.runSync(pointQuery().one({ email: "a@b.c" }))),
  time("point.warm", 100_000, () => void pointRt.runSync(warmPoint.one({ email: "a@b.c" }))),
  time("point.prepared", 100_000, () => void pointRt.runSync(preparedPoint.one({ email: "a@b.c" }))),
  time("bulk.safe", 20_000, () => void bulkRt.runSync(bulkQuery.all())),
  time("bulk.unsafe", 20_000, () => void bulkUnsafeRt.runSync(bulkQuery.all()))
]

const by = Object.fromEntries(samples.map((s) => [s.label, s.nsPerOp]))
const us = (ns: number) => (ns / 1000).toFixed(3)

console.log("\nThor hot-path overhead (no I/O, shared runtime)\n" + "-".repeat(56))
for (const s of samples) console.log(`  ${s.label.padEnd(20)} ${us(s.nsPerOp).padStart(9)} µs/op`)
console.log("\n  derived:")
console.log(`  cold → warm (compile/guard cache hit) : ${(by["point.cold"]! / by["point.warm"]!).toFixed(2)}× faster`)
console.log(`  warm → prepared (handle)              : ${(by["point.warm"]! / by["point.prepared"]!).toFixed(2)}× faster`)
console.log(`  bulk safe → unsafe (skip decode)      : ${(by["bulk.safe"]! / by["bulk.unsafe"]!).toFixed(2)}× faster`)
console.log(`\n  hot-path target: point.prepared ≤ 2 µs — ${by["point.prepared"]! <= 2000 ? "MET" : "over"} (${us(by["point.prepared"]!)} µs)`)
console.log(`\nJSON:${JSON.stringify(by)}`)

await pointRt.dispose()
await bulkRt.dispose()
await bulkUnsafeRt.dispose()

// --- staged CI gate (spec §15.16) -------------------------------------------
if (process.env.BENCH_GATE || process.env.BENCH_UPDATE_BASELINE) {
  const baselinePath = fileURLToPath(new URL("./hotpath-baseline.json", import.meta.url))
  const THRESHOLD = 2.5 // generous: fail only on catastrophic regression while baselines stabilize

  if (process.env.BENCH_UPDATE_BASELINE || !existsSync(baselinePath)) {
    mkdirSync(dirname(baselinePath), { recursive: true })
    writeFileSync(baselinePath, JSON.stringify(by, null, 2) + "\n")
    console.log(`\n[gate] baseline recorded → ${baselinePath}`)
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>
    const regressions = samples
      .filter((s) => baseline[s.label] !== undefined && s.nsPerOp > baseline[s.label]! * THRESHOLD)
      .map((s) => `${s.label}: ${us(s.nsPerOp)}µs vs baseline ${us(baseline[s.label]!)}µs (>${THRESHOLD}×)`)
    if (regressions.length > 0) {
      console.error(`\n[gate] FAIL — catastrophic regression:\n  ${regressions.join("\n  ")}`)
      process.exit(1)
    }
    console.log(`\n[gate] OK — all metrics within ${THRESHOLD}× of baseline`)
  }
}
