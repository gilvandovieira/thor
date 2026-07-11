/**
 * How much does *Thor's own code* cost per query — independent of database I/O?
 *
 * Times the pure stages (build/compile/guard), an isolated precompiled row
 * decode, and the full execution pipeline against a **constant in-memory driver**
 * (zero I/O) run through a **shared runtime** (as in a real program, not a fresh
 * fiber per call). No database, no Docker.
 *
 *   pnpm --filter @gilvandovieira/thor exec tsx scripts/bench-overhead.mts
 */
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect"
import { Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { PostgresCapabilities } from "@gilvandovieira/thor/capabilities"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { expectGuardViolations } from "@gilvandovieira/thor/testing"
import {
  formatDuration,
  formatRange,
  formatThroughput,
  measureSync,
  noiseLabel,
  timingLegend,
  type Timing
} from "./bench-report.mts"

const users = pg.table("bench_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable(),
  age: pg.integer("age").nullable()
})
const emailParam = param("email", Schema.String)

const constDriver = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  query: () => Effect.succeed(rows),
  execute: () => Effect.succeed({ rowCount: rows.length }),
  executeScript: () => Effect.succeed({ rowCount: rows.length })
})
const layerFor = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: constDriver(rows) as never,
    allowEmulation: false,
    preparedStatements: true
  })

const oneRow = [{ id: "018f0000-0000-7000-8000-000000000000", email: "a@b.c" }]
const bulkRows = Array.from({ length: 100 }, (_, i) => ({
  id: `018f0000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`,
  email: `u${i}@b.c`,
  name: i % 2 ? null : `n${i}`,
  age: i
}))

const pointQuery = () => db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, emailParam))
const bulkQuery = () => db.select({ id: users.id, email: users.email, name: users.name, age: users.age }).from(users)

const builtPoint = pointQuery()
const builtBulk = bulkQuery()
const oneRt = ManagedRuntime.make(layerFor(oneRow))
const bulkRt = ManagedRuntime.make(layerFor(bulkRows))

// Isolated decode: exactly what run.ts now does (precompiled struct decoder, sync loop).
const bulkDecoder = Schema.decodeUnknownEither(
  Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.NullOr(Schema.String), age: Schema.Number })
)
const decode100 = () => {
  for (let i = 0; i < bulkRows.length; i++) {
    const r = bulkDecoder(bulkRows[i]!)
    if (Either.isLeft(r)) throw new Error("decode failed")
  }
}

interface Row extends Timing {
  readonly label: string
}
const timeSync = (label: string, iters: number, fn: () => void): Row => ({
  label,
  ...measureSync({ iterationsPerSample: Math.ceil(iters / 5), warmupIterations: 2_000 }, fn)
})

const rows: Row[] = [
  timeSync("build (point select)", 300_000, () => void pointQuery()),
  timeSync("compile → SQL+params", 300_000, () => void builtPoint.toSql(PostgresDialect)),
  timeSync("guard (scope+caps)", 300_000, () => void expectGuardViolations(builtPoint.ir, PostgresCapabilities)),
  timeSync("decode 100 rows (precompiled)", 30_000, decode100),
  timeSync("Effect run floor (shared runtime)", 200_000, () => void oneRt.runSync(Effect.succeed(0))),
  timeSync("execute point .one() [1 row]", 100_000, () => void oneRt.runSync(builtPoint.one({ email: "a@b.c" }))),
  timeSync("execute bulk .all() [100 rows]", 30_000, () => void bulkRt.runSync(builtBulk.all()))
]

console.log(`\nThor own-code overhead — what Thor adds before the database\n${"-".repeat(105)}`)
console.log(timingLegend(rows[0]!.sampleCount))
console.log("No database, disk, or network time is included. Throughput is only an equivalent for comparison.\n")
console.log(
  `  ${"work".padEnd(48)} ${"typical".padStart(10)} ${"range".padStart(19)} ${"equivalent".padStart(17)}  consistency`
)
for (const r of rows) {
  const label = r.label.startsWith("decode 100") ? `${r.label} (${formatDuration(r.nsPerOp / 100)}/row)` : r.label
  console.log(
    `  ${label.padEnd(48)} ${formatDuration(r.nsPerOp).padStart(10)} ${formatRange(r).padStart(19)} ${formatThroughput(r.opsPerSec).padStart(17)}  ${noiseLabel(r)}`
  )
}

const pointNs = rows.find((r) => r.label.startsWith("execute point"))!.nsPerOp
const illustrativeDbNs = 150_000
console.log("\nIn everyday terms:")
console.log(
  `  • A complete one-row trip through Thor takes ${formatDuration(pointNs)} before real database waiting time.`
)
console.log(
  `  • Against an illustrative 150 µs local database round-trip, that is about ${((pointNs / illustrativeDbNs) * 100).toFixed(1)}% of the total; a real network usually makes the percentage smaller.`
)
console.log(
  "  • The range matters: if it is wide or marked noisy, rerun before drawing conclusions from a small difference."
)
console.log()

await oneRt.dispose()
await bulkRt.dispose()
