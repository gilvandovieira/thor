/**
 * Query-cache layer benchmark + hit/miss counters (spec §9, §19, Epic L6).
 *
 * Measures the named cache layers (spec §9.1) across the precompilation axes and
 * prints the per-layer hit/miss/eviction counters that make cache effectiveness
 * observable (feeds Epic S observability):
 *   - cold      : query rebuilt every call → every shape-keyed layer misses
 *   - warm      : stable IR reused → shape/compile/decoder/capability hit
 *   - prepared  : `.compilePrepared()` handle → precompiled, prepared reuse
 *   - bounded   : a small LRU registry → eviction counters move
 *
 *   pnpm bench:cache
 */
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Database, db, eq, makeQueryCaches, param, pg, type QueryCaches } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import {
  formatDuration,
  formatRange,
  formatThroughput,
  measureSync,
  noiseLabel,
  percentFaster,
  timingLegend,
  type Timing
} from "./bench-report.mts"

const users = pg.table("bench_cache_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable()
})
const emailParam = param("email", Schema.String)

/** Constant, zero-I/O driver plus a `Database` layer carrying an explicit cache registry. */
const layerFor = (caches: QueryCaches, rows: ReadonlyArray<Record<string, unknown>>) =>
  Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: {
      query: () => Effect.succeed(rows),
      execute: () => Effect.succeed({ rowCount: rows.length }),
      executeScript: () => Effect.succeed({ rowCount: 0 })
    },
    allowEmulation: false,
    preparedStatements: true,
    queryCache: caches
  } as never)

const rows = [{ id: "018f0000-0000-7000-8000-000000000001", name: "Ada" }]
const pointQuery = () => db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, emailParam))

const warmCaches = makeQueryCaches()
const warmQuery = pointQuery()
const warmRt = ManagedRuntime.make(layerFor(warmCaches, rows))

const coldCaches = makeQueryCaches()
const coldRt = ManagedRuntime.make(layerFor(coldCaches, rows))

const preparedCaches = makeQueryCaches()
const preparedHandle = pointQuery().one().compilePrepared()
const preparedRt = ManagedRuntime.make(layerFor(preparedCaches, rows))

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
  time("cache.cold", "rebuild the query every time", 100_000, () =>
    void coldRt.runSync(pointQuery().one({ email: "a@b.c" }))
  ),
  time("cache.warm", "reuse the same query (layers hit)", 100_000, () =>
    void warmRt.runSync(warmQuery.one({ email: "a@b.c" }))
  ),
  time("cache.prepared", "compiled + prepared handle", 100_000, () =>
    void preparedRt.runSync(preparedHandle.execute({ email: "a@b.c" }))
  )
]

const by = Object.fromEntries(samples.map((s) => [s.label, s.nsPerOp]))

console.log("\nThor query-cache layers — Thor's cost only, with no database or network\n" + "-".repeat(100))
console.log(timingLegend(samples[0]!.sampleCount))
console.log(
  `  ${"path".padEnd(18)} ${"what it does".padEnd(38)} ${"typical".padStart(10)} ${"range".padStart(19)} ${"equivalent".padStart(17)}  consistency`
)
for (const s of samples) {
  console.log(
    `  ${s.label.padEnd(18)} ${s.description.padEnd(38)} ${formatDuration(s.nsPerOp).padStart(10)} ${formatRange(s).padStart(19)} ${formatThroughput(s.opsPerSec).padStart(17)}  ${noiseLabel(s)}`
  )
}

console.log(
  `\n  • Reusing a query removes ${percentFaster(by["cache.cold"]!, by["cache.warm"]!).toFixed(0)}% of Thor's per-call work; a prepared handle removes another ${percentFaster(by["cache.warm"]!, by["cache.prepared"]!).toFixed(0)}%.`
)

// --- per-layer hit/miss counters (spec §9, L6) ------------------------------
const statsTable = (title: string, caches: QueryCaches) => {
  console.log(`\n${title}`)
  console.log(`  ${"layer".padEnd(12)} ${"hits".padStart(10)} ${"misses".padStart(10)} ${"evictions".padStart(10)} ${"size".padStart(8)} ${"maxSize".padStart(8)}`)
  for (const s of caches.stats()) {
    console.log(
      `  ${s.name.padEnd(12)} ${String(s.hits).padStart(10)} ${String(s.misses).padStart(10)} ${String(s.evictions).padStart(10)} ${String(s.size ?? "—").padStart(8)} ${String(s.maxSize ?? "—").padStart(8)}`
    )
  }
}
statsTable("Warm registry — counters after the warm benchmark (high hit ratio expected):", warmCaches)

// Demonstrate bounded LRU eviction on a small registry.
const boundedCaches = makeQueryCaches({ maxSize: 4, strategy: "lru" })
const boundedRt = ManagedRuntime.make(layerFor(boundedCaches, rows))
for (let i = 0; i < 32; i++) {
  // A fresh selection shape each iteration → the compile layer overflows its bound.
  const q = db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, param(`p${i}`, Schema.String)))
  boundedRt.runSync(q.one({ [`p${i}`]: "a@b.c" }))
}
statsTable("Bounded registry (maxSize 4) — 32 distinct shapes force evictions:", boundedCaches)

console.log(`\nJSON:${JSON.stringify(by)}`)

await coldRt.dispose()
await warmRt.dispose()
await preparedRt.dispose()
await boundedRt.dispose()
