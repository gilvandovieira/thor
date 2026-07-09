/**
 * "Hit home" benchmark: Thor over **in-memory SQLite** (`node:sqlite`).
 *
 * SQLite here is synchronous and in-process, so a query round-trip is a
 * *microsecond* — there is no network or disk to hide behind. That makes Thor's
 * own overhead a large, honest share of the total, and shows exactly what the
 * decode + memoization work bought. We compare, per scenario:
 *   - raw node:sqlite (prepared) — the floor,
 *   - Thor with prepared statements OFF and ON,
 * and report Thor's overhead over raw and its share of the total.
 *
 *   pnpm bench:sqlite     (no Docker — in-memory)
 */
import { performance } from "node:perf_hooks"
import { ManagedRuntime, Schema } from "effect"
import { db, eq, param, sqlite } from "@gilvandovieira/thor"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"

// Runtime-agnostic SQLite: node:sqlite under Node, bun:sqlite under Bun. The
// specifier is a variable so neither bundler tries to statically resolve the
// other runtime's module.
const RUNTIME = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : "node"
const sqliteMod = (await import(RUNTIME === "bun" ? "bun:sqlite" : "node:sqlite")) as {
  DatabaseSync?: new (path: string) => unknown
  Database?: new (path: string) => unknown
}
const makeDb = (): { exec: (s: string) => unknown; prepare: (s: string) => any; close: () => void } =>
  (RUNTIME === "bun" ? new sqliteMod.Database!(":memory:") : new sqliteMod.DatabaseSync!(":memory:")) as never

const notes = sqlite.table("bench_notes", {
  id: sqlite.integer("id").primaryKey(),
  body: sqlite.text("body").notNull(),
  n: sqlite.integer("n").nullable()
})
const idParam = param("id", Schema.Number)

const fresh = () => {
  const client = makeDb()
  client.exec("create table bench_notes (id integer primary key, body text not null, n integer);")
  const ins = client.prepare("insert into bench_notes (id, body, n) values (?, ?, ?)")
  ins.run(1, "point", 1)
  for (let i = 0; i < 200; i++) ins.run(i + 2, `bulk${i}`, i)
  return client
}

const timeSync = (iters: number, fn: (i: number) => void): number => {
  for (let i = 0; i < Math.min(iters, 2000); i++) fn(-1 - i)
  const start = performance.now()
  for (let i = 0; i < iters; i++) fn(i)
  return ((performance.now() - start) * 1e6) / iters // ns/op
}

const pointQ = db.select({ id: notes.id, body: notes.body }).from(notes).where(eq(notes.id, idParam))
const bulkQ = db.select({ id: notes.id, body: notes.body, n: notes.n }).from(notes)

interface Line {
  readonly scenario: string
  readonly raw: number
  readonly off: number
  readonly on: number
}

const bench = (): Line[] => {
  // --- raw node:sqlite floor (prepared once, reused) ---
  const rawClient = fresh()
  const rawPoint = rawClient.prepare("select id, body from bench_notes where id = ?")
  const rawBulk = rawClient.prepare("select id, body, n from bench_notes")
  const rawPointNs = timeSync(200_000, () => void rawPoint.all(1))
  const rawBulkNs = timeSync(20_000, () => void rawBulk.all())
  rawClient.close()

  // --- Thor, prepared OFF vs ON (fresh DB + runtime per mode) ---
  const thor = (prepared: boolean) => {
    const client = fresh()
    const rt = ManagedRuntime.make(SQLiteLayer(client as never, { preparedStatements: prepared }))
    const point = timeSync(150_000, () => void rt.runSync(pointQ.one({ id: 1 })))
    const bulk = timeSync(20_000, () => void rt.runSync(bulkQ.all()))
    client.close()
    return { point, bulk }
  }
  const off = thor(false)
  const on = thor(true)

  return [
    { scenario: "select.point", raw: rawPointNs, off: off.point, on: on.point },
    { scenario: "select.bulk200", raw: rawBulkNs, off: off.bulk, on: on.bulk }
  ]
}

const us = (ns: number) => (ns / 1000).toFixed(3)
const lines = bench()

console.log(`\nThor over in-memory SQLite (${RUNTIME === "bun" ? "bun:sqlite" : "node:sqlite"}, runtime=${RUNTIME}) — µs/op\n` + "-".repeat(78))
console.log(
  `  ${"scenario".padEnd(16)} ${"raw sqlite".padStart(11)} ${"Thor off".padStart(10)} ${"Thor on".padStart(10)} ${"overhead".padStart(10)} ${"Thor share".padStart(11)}`
)
for (const l of lines) {
  const overhead = l.on - l.raw
  const share = (l.on - l.raw) / l.on
  console.log(
    `  ${l.scenario.padEnd(16)} ${us(l.raw).padStart(11)} ${us(l.off).padStart(10)} ${us(l.on).padStart(10)} ${us(overhead).padStart(10)} ${(share * 100).toFixed(0).padStart(9)} %`
  )
}

const point = lines.find((l) => l.scenario === "select.point")!
console.log("\nWhat this hits home:")
console.log(
  `  • A point select is ~${us(point.on)} µs total; raw SQLite is ~${us(point.raw)} µs, so Thor is ~${(((point.on - point.raw) / point.on) * 100).toFixed(0)}% of it.`
)
console.log(
  `  • Prepared statements matter even for SQLite: ${(point.off / point.on).toFixed(2)}× faster on than off (skips re-prepare).`
)
console.log(
  "  • With a µs-fast DB the abstraction is visible — which is why decode + compile/guard memoization matter."
)
console.log("  • Over a networked Postgres (~150 µs) that same ~few-µs of Thor is <2%.\n")
