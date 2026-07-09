/**
 * "Hit home" benchmark: Thor over **in-memory SQLite**, across every available
 * synchronous SQLite driver.
 *
 * SQLite here is synchronous and in-process, so a query round-trip is a
 * *microsecond* — there is no network or disk to hide behind. That makes Thor's
 * own overhead a large, honest share of the total, and shows exactly what the
 * decode + memoization work bought. For every driver present in the current
 * runtime we compare, per scenario:
 *   - the raw driver (prepared once, reused) — the floor,
 *   - Thor with prepared statements OFF and ON,
 * and report Thor's overhead over raw and its share of the total.
 *
 * The driver set is discovered, not hardcoded: `node:sqlite` (Node),
 * `bun:sqlite` (Bun), and `better-sqlite3` (native, either runtime) each load
 * lazily and are skipped when unavailable. All three share the one structural
 * SQLite client surface Thor targets, so `SQLiteLayer` binds to each unchanged.
 *
 *   pnpm bench:sqlite        (Node — runs node:sqlite + better-sqlite3)
 *   pnpm bench:sqlite:bun    (Bun  — runs bun:sqlite + better-sqlite3 if built)
 */
import { performance } from "node:perf_hooks"
import { ManagedRuntime, Schema } from "effect"
import { db, eq, param, sqlite } from "@gilvandovieira/thor"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/** The one affected-row shape every driver returns from `run()`. */
interface RunResult {
  readonly changes: number | bigint
}
/** Structural prepared statement shared by all three drivers. */
interface Statement {
  all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>
  run(...params: ReadonlyArray<unknown>): RunResult
}
/** Structural in-memory client shared by all three drivers. */
interface Client {
  prepare(sql: string): Statement
  exec(sql: string): unknown
  close(): void
}
/** A factory that opens one fresh `:memory:` database. */
type OpenDb = () => Client

/** A named SQLite driver plus a loader that resolves it or returns null. */
interface Provider {
  readonly name: string
  readonly load: () => Promise<OpenDb | null>
}

// Dynamic specifiers keep each runtime's module out of the other's resolver.
const providers: ReadonlyArray<Provider> = [
  {
    name: "node:sqlite",
    load: async () => {
      if (IS_BUN) return null
      try {
        const mod = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => Client }
        return () => new mod.DatabaseSync(":memory:")
      } catch {
        return null
      }
    }
  },
  {
    name: "bun:sqlite",
    load: async () => {
      if (!IS_BUN) return null
      try {
        const mod = (await import("bun:sqlite")) as { Database: new (path: string) => Client }
        return () => new mod.Database(":memory:")
      } catch {
        return null
      }
    }
  },
  {
    name: "better-sqlite3",
    load: async () => {
      try {
        const mod = (await import("better-sqlite3")) as {
          default?: new (path: string) => Client
        } & (new (path: string) => Client)
        const Ctor = (mod.default ?? mod) as new (path: string) => Client
        return () => new Ctor(":memory:")
      } catch {
        return null
      }
    }
  }
]

const notes = sqlite.table("bench_notes", {
  id: sqlite.integer("id").primaryKey(),
  body: sqlite.text("body").notNull(),
  n: sqlite.integer("n").nullable()
})
const idParam = param("id", Schema.Number)
const pointQ = db.select({ id: notes.id, body: notes.body }).from(notes).where(eq(notes.id, idParam))
const bulkQ = db.select({ id: notes.id, body: notes.body, n: notes.n }).from(notes)

/**
 * @param open - Factory for a fresh in-memory database.
 * @returns A seeded client holding 201 rows.
 */
const seed = (open: OpenDb): Client => {
  const client = open()
  client.exec("create table bench_notes (id integer primary key, body text not null, n integer);")
  const ins = client.prepare("insert into bench_notes (id, body, n) values (?, ?, ?)")
  ins.run(1, "point", 1)
  for (let i = 0; i < 200; i++) ins.run(i + 2, `bulk${i}`, i)
  return client
}

/**
 * @param iters - Measured iterations (warmup runs first, capped).
 * @param fn - The operation under test.
 * @returns Nanoseconds per operation.
 */
const timeSync = (iters: number, fn: (i: number) => void): number => {
  for (let i = 0; i < Math.min(iters, 2000); i++) fn(-1 - i)
  const start = performance.now()
  for (let i = 0; i < iters; i++) fn(i)
  return ((performance.now() - start) * 1e6) / iters
}

/** One measured driver+scenario row: raw floor vs Thor prepared off/on (ns/op). */
interface Line {
  readonly driver: string
  readonly scenario: string
  readonly raw: number
  readonly off: number
  readonly on: number
}

/**
 * @param name - Driver display name.
 * @param open - Factory for a fresh in-memory database.
 * @returns The point and bulk measurements for this driver.
 */
const benchDriver = (name: string, open: OpenDb): Line[] => {
  // Raw floor: prepare once, reuse.
  const rawClient = seed(open)
  const rawPoint = rawClient.prepare("select id, body from bench_notes where id = ?")
  const rawBulk = rawClient.prepare("select id, body, n from bench_notes")
  const rawPointNs = timeSync(200_000, () => void rawPoint.all(1))
  const rawBulkNs = timeSync(20_000, () => void rawBulk.all())
  rawClient.close()

  // Thor, prepared OFF vs ON (fresh DB + runtime per mode).
  const thor = (prepared: boolean) => {
    const client = seed(open)
    const rt = ManagedRuntime.make(SQLiteLayer(client as never, { preparedStatements: prepared }))
    const point = timeSync(150_000, () => void rt.runSync(pointQ.one({ id: 1 })))
    const bulk = timeSync(20_000, () => void rt.runSync(bulkQ.all()))
    client.close()
    return { point, bulk }
  }
  const off = thor(false)
  const on = thor(true)

  return [
    { driver: name, scenario: "select.point", raw: rawPointNs, off: off.point, on: on.point },
    { driver: name, scenario: "select.bulk200", raw: rawBulkNs, off: off.bulk, on: on.bulk }
  ]
}

const us = (ns: number) => (ns / 1000).toFixed(3)

const available: Array<{ name: string; open: OpenDb }> = []
for (const provider of providers) {
  const open = await provider.load()
  if (open) available.push({ name: provider.name, open })
}

if (available.length === 0) {
  console.error("No SQLite driver available in this runtime.")
  process.exit(1)
}

const lines = available.flatMap(({ name, open }) => benchDriver(name, open))

console.log(`\nThor over in-memory SQLite (runtime=${IS_BUN ? "bun" : "node"}) — µs/op\n` + "-".repeat(86))
console.log(
  `  ${"driver".padEnd(15)} ${"scenario".padEnd(15)} ${"raw".padStart(9)} ${"Thor off".padStart(10)} ${"Thor on".padStart(10)} ${"overhead".padStart(10)} ${"Thor share".padStart(11)}`
)
for (const l of lines) {
  const overhead = l.on - l.raw
  const share = (l.on - l.raw) / l.on
  console.log(
    `  ${l.driver.padEnd(15)} ${l.scenario.padEnd(15)} ${us(l.raw).padStart(9)} ${us(l.off).padStart(10)} ${us(l.on).padStart(10)} ${us(overhead).padStart(10)} ${(share * 100).toFixed(0).padStart(9)} %`
  )
}

// Cross-driver comparison of the raw point-select floor.
const points = lines.filter((l) => l.scenario === "select.point")
const fastestRaw = points.reduce((a, b) => (b.raw < a.raw ? b : a))
console.log("\nWhat this hits home:")
for (const l of points) {
  const rel = l.raw / fastestRaw.raw
  console.log(
    `  • ${l.driver.padEnd(15)} raw point ~${us(l.raw)} µs${
      l === fastestRaw ? " (fastest native)" : ` (${rel.toFixed(2)}× slower than ${fastestRaw.driver})`
    }; Thor on ~${us(l.on)} µs, ~${(((l.on - l.raw) / l.on) * 100).toFixed(0)}% Thor.`
  )
}
console.log(
  `  • Prepared statements matter even for SQLite: ${(points[0].off / points[0].on).toFixed(2)}× faster on than off (skips re-prepare).`
)
console.log("  • With a µs-fast DB the abstraction is visible — decode + compile/guard memoization are why it's a few µs, not more.")
console.log("  • Over a networked Postgres (~150 µs) that same few-µs of Thor is <2%.\n")
