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
import { performance } from "node:perf_hooks"
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect"
import { Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { PostgresCapabilities } from "@gilvandovieira/thor/capabilities"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { expectGuardViolations } from "@gilvandovieira/thor/testing"

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
  id: "018f0000-0000-7000-8000-0000000000" + String(i).padStart(2, "0"),
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

interface Row {
  readonly label: string
  readonly nsPerOp: number
  readonly perUnit?: string
}
const timeSync = (label: string, iters: number, fn: () => void, perUnit?: string): Row => {
  for (let i = 0; i < Math.min(iters, 2000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return { label, nsPerOp: ((performance.now() - start) * 1e6) / iters, ...(perUnit ? { perUnit } : {}) }
}

const rows: Row[] = [
  timeSync("build (point select)", 300_000, () => void pointQuery()),
  timeSync("compile → SQL+params", 300_000, () => void builtPoint.toSql(PostgresDialect)),
  timeSync("guard (scope+caps)", 300_000, () => void expectGuardViolations(builtPoint.ir, PostgresCapabilities)),
  timeSync("decode 100 rows (precompiled)", 30_000, decode100, "→ per row"),
  timeSync("Effect run floor (shared runtime)", 200_000, () => void oneRt.runSync(Effect.succeed(0))),
  timeSync("execute point .one() [1 row]", 100_000, () => void oneRt.runSync(builtPoint.one({ email: "a@b.c" }))),
  timeSync("execute bulk .all() [100 rows]", 30_000, () => void bulkRt.runSync(builtBulk.all()))
]

const us = (ns: number) => (ns / 1000).toFixed(3)
console.log("\nThor own-code overhead (no database I/O, shared runtime)\n" + "-".repeat(66))
for (const r of rows) {
  const line = `  ${r.label.padEnd(38)} ${us(r.nsPerOp).padStart(9)} µs`
  if (r.label.startsWith("decode 100")) console.log(`${line}   (${us(r.nsPerOp / 100)} µs/row)`)
  else console.log(line)
}

const point = rows.find((r) => r.label.startsWith("execute point"))!.nsPerOp / 1e6
const REAL_DB_POINT_MS = 0.15
console.log("\nShare of a real prepared point-select round-trip (loopback)")
console.log(`  Thor own code:  ${(point * 1000).toFixed(1)} µs/query`)
console.log(`  DB round-trip:  ~${REAL_DB_POINT_MS * 1000} µs/query (prepared)`)
console.log(`  Thor ≈ ${((point / REAL_DB_POINT_MS) * 100).toFixed(1)}% of the total.`)
console.log()

await oneRt.dispose()
await bulkRt.dispose()
