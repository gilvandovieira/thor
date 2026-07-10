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
import { ManagedRuntime, Schema } from "effect"
import { db, eq, param, sqlite } from "@gilvandovieira/thor"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"
import {
  formatDuration,
  formatRange,
  formatTimeChange,
  measureSync,
  noiseLabel,
  timingLegend,
  type Timing
} from "./bench-report.mts"

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

const timeSync = (iters: number, fn: (i: number) => void): Timing =>
  measureSync({ iterationsPerSample: Math.ceil(iters / 5), warmupIterations: 2_000 }, fn)

/** One measured driver+scenario row: raw floor vs Thor prepared off/on (ns/op). */
interface Line {
  readonly driver: string
  readonly scenario: string
  readonly raw: Timing
  readonly off: Timing
  readonly on: Timing
}

/**
 * @param name - Driver display name.
 * @param open - Factory for a fresh in-memory database.
 * @returns The point and bulk measurements for this driver.
 */
const benchDriver = async (name: string, open: OpenDb): Promise<Line[]> => {
  // Raw floor: prepare once, reuse.
  const rawClient = seed(open)
  const rawPoint = rawClient.prepare("select id, body from bench_notes where id = ?")
  const rawBulk = rawClient.prepare("select id, body, n from bench_notes")
  const rawPointNs = timeSync(200_000, () => void rawPoint.all(1))
  const rawBulkNs = timeSync(20_000, () => void rawBulk.all())
  rawClient.close()

  // Thor, prepared OFF vs ON (fresh DB + runtime per mode).
  const thor = async (prepared: boolean) => {
    const client = seed(open)
    const rt = ManagedRuntime.make(SQLiteLayer(client as never, { preparedStatements: prepared }))
    const point = timeSync(150_000, () => void rt.runSync(pointQ.one({ id: 1 })))
    const bulk = timeSync(20_000, () => void rt.runSync(bulkQ.all()))
    await rt.dispose()
    client.close()
    return { point, bulk }
  }
  const off = await thor(false)
  const on = await thor(true)

  return [
    { driver: name, scenario: "select.point", raw: rawPointNs, off: off.point, on: on.point },
    { driver: name, scenario: "select.bulk200", raw: rawBulkNs, off: off.bulk, on: on.bulk }
  ]
}

const available: Array<{ name: string; open: OpenDb }> = []
for (const provider of providers) {
  const open = await provider.load()
  if (open) available.push({ name: provider.name, open })
}

if (available.length === 0) {
  console.error("No SQLite driver available in this runtime.")
  process.exit(1)
}

const lines: Line[] = []
for (const { name, open } of available) lines.push(...(await benchDriver(name, open)))

console.log(`\nThor over in-memory SQLite (runtime=${IS_BUN ? "bun" : "node"}) — a deliberately harsh stress test\n` + "-".repeat(116))
console.log(timingLegend(lines[0]!.on.sampleCount))
console.log("SQLite runs in this process with no network, so Thor's few microseconds are unusually visible.\n")
console.log(
  `  ${"driver".padEnd(15)} ${"scenario".padEnd(15)} ${"raw driver".padStart(11)} ${"Thor off".padStart(10)} ${"Thor on".padStart(10)} ${"on range".padStart(19)} ${"Thor adds".padStart(10)} ${"share".padStart(7)}  consistency`
)
for (const l of lines) {
  const overhead = l.on.nsPerOp - l.raw.nsPerOp
  const share = overhead / l.on.nsPerOp
  console.log(
    `  ${l.driver.padEnd(15)} ${l.scenario.padEnd(15)} ${formatDuration(l.raw.nsPerOp).padStart(11)} ${formatDuration(l.off.nsPerOp).padStart(10)} ${formatDuration(l.on.nsPerOp).padStart(10)} ${formatRange(l.on).padStart(19)} ${formatDuration(overhead).padStart(10)} ${(share * 100).toFixed(0).padStart(5)} %  ${noiseLabel(l.on)}`
  )
}

// Cross-driver comparison of the raw point-select floor.
const points = lines.filter((l) => l.scenario === "select.point")
const fastestRaw = points.reduce((a, b) => (b.raw.nsPerOp < a.raw.nsPerOp ? b : a))
console.log("\nIn everyday terms:")
for (const l of points) {
  const rel = l.raw.nsPerOp / fastestRaw.raw.nsPerOp
  console.log(
    `  • ${l.driver}: the driver alone takes ${formatDuration(l.raw.nsPerOp)}${
      l === fastestRaw ? " (fastest native)" : ` (${rel.toFixed(2)}× slower than ${fastestRaw.driver})`
    }; with Thor it takes ${formatDuration(l.on.nsPerOp)}, of which about ${(((l.on.nsPerOp - l.raw.nsPerOp) / l.on.nsPerOp) * 100).toFixed(0)}% is Thor.`
  )
}
console.log(
  `  • Preparation uses ${formatTimeChange(points[0]!.off.nsPerOp, points[0]!.on.nsPerOp)} point-query time for ${points[0]!.driver} by avoiding repeated setup.`
)
console.log("  • This is close to a worst case for library overhead. A network database adds far more waiting time, shrinking Thor's percentage.")
console.log("  • Compare the absolute time and the sample range; percentages alone can sound dramatic when the total is only a few microseconds.\n")
