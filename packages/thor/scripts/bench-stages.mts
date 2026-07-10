/**
 * Independent v1 stage benchmarks (spec §19.1-19.2, roadmap W1).
 *
 * Each case measures one boundary only. Use a group argument to run one stage,
 * or `all` to run the same matrix under Node and Bun.
 */
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect"
import { Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import {
  formatDuration,
  formatRange,
  formatThroughput,
  measureSync,
  noiseLabel,
  runtimeName,
  timingLegend,
  type Timing
} from "./bench-report.mts"

const groups = ["build", "ir", "compile", "decode", "effect"] as const
type StageGroup = (typeof groups)[number]

const requested = process.argv[2] ?? "all"
if (requested !== "all" && !groups.includes(requested as StageGroup)) {
  throw new Error(`Unknown benchmark stage "${requested}"; expected ${groups.join(", ")}, or all`)
}

const users = pg.table("bench_stage_users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable()
})
const emailParam = param("email", Schema.String)
const selection = () => db.select({ id: users.id, email: users.email, name: users.name })
const pointQuery = () => selection().from(users).where(eq(users.email, emailParam))
const builtPoint = pointQuery()
const decoder = Schema.decodeUnknownEither(Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String)
}))
const rawRow = { id: "018f0000-0000-7000-8000-000000000001", email: "a@b.c", name: "Ada" }
const runtime = ManagedRuntime.make(Layer.succeed(Database, {
  dialect: PostgresDialect,
  driver: {
    runtime: { adapter: "bench/stage", required: [] },
    query: () => Effect.succeed([]),
    execute: () => Effect.succeed({ rowCount: 0 })
  },
  allowEmulation: false,
  preparedStatements: false
}))

interface StageTiming extends Timing {
  readonly group: StageGroup
  readonly description: string
}

const iterations = Number(process.env.BENCH_ITERATIONS ?? 200_000)
if (!Number.isInteger(iterations) || iterations < 1_000) {
  throw new Error(`BENCH_ITERATIONS must be an integer >= 1000; received ${iterations}`)
}

const measure = (group: StageGroup, description: string, fn: () => void): StageTiming => ({
  group,
  description,
  ...measureSync({ iterationsPerSample: iterations, warmupIterations: 2_000 }, fn)
})

const cases: Record<StageGroup, () => StageTiming> = {
  build: () => measure("build", "create the typed selection builder", () => void selection()),
  ir: () => measure("ir", "construct the complete immutable query IR", () => void pointQuery().ir),
  compile: () => measure("compile", "compile one stable IR to SQL", () => void builtPoint.toSql(PostgresDialect)),
  decode: () => measure("decode", "decode one row with a precompiled schema", () => {
    if (Either.isLeft(decoder(rawRow))) throw new Error("benchmark row failed to decode")
  }),
  effect: () => measure("effect", "cross one shared Effect runtime boundary", () => void runtime.runSync(Effect.succeed(0)))
}

const selected = requested === "all" ? groups : [requested as StageGroup]
const results = selected.map((group) => cases[group]())

console.log(`\nThor v1 stage benchmarks (${runtimeName()})\n${"-".repeat(105)}`)
console.log(timingLegend(results[0]!.sampleCount))
console.log("Each row measures one stage; no database, disk, or network time is included.\n")
console.log(`  ${"stage".padEnd(10)} ${"boundary".padEnd(45)} ${"typical".padStart(10)} ${"range".padStart(19)} ${"equivalent".padStart(17)}  consistency`)
for (const result of results) {
  console.log(
    `  ${result.group.padEnd(10)} ${result.description.padEnd(45)} ${formatDuration(result.nsPerOp).padStart(10)} ${formatRange(result).padStart(19)} ${formatThroughput(result.opsPerSec).padStart(17)}  ${noiseLabel(result)}`
  )
}
console.log(`\nJSON:${JSON.stringify({
  runtime: runtimeName(),
  metrics: Object.fromEntries(results.map((result) => [result.group, result.nsPerOp]))
})}`)

await runtime.dispose()
