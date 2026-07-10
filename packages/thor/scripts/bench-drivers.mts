/**
 * Independent per-driver performance benchmark (real Postgres), with and without
 * prepared statements (spec §16).
 *
 * Drives identical Thor workloads through each driver adapter (node-postgres and
 * postgres.js), each in two modes — `preparedStatements: false` (re-parse every
 * call) and `true` (reuse a server-side prepared statement keyed by the compiled
 * cacheKey) — and reports latency + throughput so we can see, independently:
 *   1. how much preparation buys per driver, and
 *   2. how the two drivers compare.
 *
 *   DATABASE_URL=postgres://thor:thor@localhost:5433/thor pnpm bench:drivers
 *   # or: pnpm bench:e2e   (manages Docker)
 */
import pgLib from "pg"
import postgres from "postgres"
import { Effect, Schema, type Layer } from "effect"
import { Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { PostgresJsLayer, PostgresLayer } from "@gilvandovieira/thor/postgres"
import {
  formatDuration,
  formatRange,
  formatTimeChange,
  measureAsync,
  noiseLabel,
  timingLegend,
  type Timing
} from "./bench-report.mts"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("bench-drivers: set DATABASE_URL")
  process.exit(1)
}

const users = pg.table("bench_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").nullable(),
  age: pg.integer("age").nullable()
})

const emailParam = param("email", Schema.String)
const BULK_ROWS = 200

interface Sample extends Timing {
  readonly scenario: string
}

const time = async (scenario: string, iterations: number, fn: (i: number) => Promise<unknown>): Promise<Sample> => {
  const timing = await measureAsync({ iterationsPerSample: iterations, warmupIterations: 30 }, fn)
  return { scenario, ...timing }
}

const CREATE = `create table bench_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique, name text, age integer
);`

/** Identical workload set for every driver/mode. `run` executes an Effect against the layer. */
const runScenarios = async (run: <A, E>(e: Effect.Effect<A, E, Database>) => Promise<A>): Promise<Sample[]> => [
  // Reads run before writes so the bulk fixture stays exactly 200 rows.
  await time("select.point", 600, () =>
    run(db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, emailParam)).one({ email: "point@bench" }))
  ),
  await time("select.bulk200", 150, () =>
    run(db.select({ id: users.id, email: users.email, name: users.name, age: users.age }).from(users).limit(BULK_ROWS).all())
  ),
  await time("insert", 400, (i) => run(db.insert(users).values({ email: `ins${i}@bench`, name: "x" }).run())),
  await time("insert.returning", 400, (i) =>
    run(db.insert(users).values({ email: `insr${i}@bench` }).returning({ id: users.id }).one())
  ),
  await time("update.point", 400, (i) =>
    run(db.update(users).set({ name: `n${i}` }).where(eq(users.email, emailParam)).run({ email: "point@bench" }))
  )
]

interface Combo {
  readonly layer: Layer.Layer<Database>
  readonly seed: () => Promise<void>
  readonly teardown: () => Promise<void>
}

/** A fresh connection + layer per (driver, mode) so prepared-statement caches never leak across runs. */
const makeCombo = async (driver: "node-postgres" | "postgres.js", prepared: boolean): Promise<Combo> => {
  if (driver === "node-postgres") {
    const client = new pgLib.Client({ connectionString: url })
    await client.connect()
    const seed = async () => {
      await client.query("drop schema public cascade; create schema public;")
      await client.query(CREATE)
      await client.query("insert into bench_users (email, name, age) values ('point@bench', 'p', 1);")
      for (let i = 0; i < BULK_ROWS; i++)
        await client.query("insert into bench_users (email, name, age) values ($1,$2,$3)", [`bulk${i}@bench`, "b", i])
    }
    return { layer: PostgresLayer(client, { preparedStatements: prepared }), seed, teardown: () => client.end() }
  }
  const sql = postgres(url!, { max: 1, onnotice: () => {} })
  const seed = async () => {
    await sql.unsafe("drop schema public cascade; create schema public;").simple()
    await sql.unsafe(CREATE)
    await sql.unsafe("insert into bench_users (email, name, age) values ('point@bench', 'p', 1);")
    for (let i = 0; i < BULK_ROWS; i++)
      await sql.unsafe("insert into bench_users (email, name, age) values ($1,$2,$3)", [`bulk${i}@bench`, "b", i])
  }
  const layer = PostgresJsLayer(
    { unsafe: (q, p, o) => sql.unsafe(q, p as never, o as never) },
    { preparedStatements: prepared }
  )
  return { layer, seed, teardown: () => sql.end({ timeout: 5 }).then(() => undefined) }
}

const benchCombo = async (driver: "node-postgres" | "postgres.js", prepared: boolean): Promise<Sample[]> => {
  const combo = await makeCombo(driver, prepared)
  const run = <A, E>(e: Effect.Effect<A, E, Database>) => Effect.runPromise(Effect.provide(e, combo.layer))
  await combo.seed()
  const samples = await runScenarios(run)
  await combo.teardown()
  return samples
}

const main = async () => {
  const results: Record<string, { off: Sample[]; on: Sample[] }> = {}
  console.log("\nThor with a real local PostgreSQL database\n" + "-".repeat(105))
  console.log("Smaller time is faster. The database runs over loopback; production network, disk, pooling, and concurrency will differ.")
  for (const driver of ["node-postgres", "postgres.js"] as const) {
    const off = await benchCombo(driver, false)
    const on = await benchCombo(driver, true)
    results[driver] = { off, on }
    console.log(`\n${driver} — preparation OFF versus ON`)
    console.log(timingLegend(on[0]!.sampleCount))
    console.log(
      `  ${"work".padEnd(18)} ${"off typical".padStart(12)} ${"on typical".padStart(12)} ${"on range".padStart(19)} ${"time change".padStart(14)}  consistency`
    )
    off.forEach((o, i) => {
      const p = on[i]!
      console.log(
        `  ${o.scenario.padEnd(18)} ${formatDuration(o.nsPerOp).padStart(12)} ${formatDuration(p.nsPerOp).padStart(12)} ${formatRange(p).padStart(19)} ${formatTimeChange(o.nsPerOp, p.nsPerOp).padStart(14)}  ${noiseLabel(p)}`
      )
    })
  }

  console.log("\nDriver comparison with preparation ON")
  const pg2 = results["node-postgres"]!.on
  const js2 = new Map(results["postgres.js"]!.on.map((s) => [s.scenario, s]))
  console.log(`  ${"work".padEnd(18)} ${"node-postgres".padStart(14)} ${"postgres.js".padStart(14)}  plain reading`)
  for (const a of pg2) {
    const b = js2.get(a.scenario)!
    const ratio = a.nsPerOp / b.nsPerOp
    const reading = ratio >= 0.9 && ratio <= 1.1 ? "roughly even" : ratio < 1 ? "node-postgres faster" : "postgres.js faster"
    console.log(
      `  ${a.scenario.padEnd(18)} ${formatDuration(a.nsPerOp).padStart(14)} ${formatDuration(b.nsPerOp).padStart(14)}  ${reading}`
    )
  }

  const preparedPoints = [results["node-postgres"]!.on[0]!, results["postgres.js"]!.on[0]!]
  console.log("\nIn everyday terms:")
  console.log("  • Preparation mainly helps repeated parameterized work by letting PostgreSQL reuse setup it has already done.")
  console.log(
    `  • A prepared one-row lookup takes ${formatDuration(preparedPoints[0]!.nsPerOp)} with node-postgres and ${formatDuration(preparedPoints[1]!.nsPerOp)} with postgres.js on this local setup.`
  )
  console.log("  • Differences inside a wide sample range are noise, not a reason to switch drivers.")

  console.log(`\nJSON:${JSON.stringify(results)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
