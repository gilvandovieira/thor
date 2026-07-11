import { Cause, Console, Effect, Exit } from "effect"
import { Database, SQLiteDialect, db, excluded } from "@gilvandovieira/thor"
import { makeIntrospector } from "@gilvandovieira/thor/introspect"
import { compilePlan, defineMigration, makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { readInput } from "./data.js"
import {
  FindEvent,
  UpdateImportRun,
  UpsertDailyMetric,
  UpsertRawEvent,
  activeMetrics,
  clearDailyMetrics,
  groupedMetrics,
  highValueMetrics,
  partnerEvents,
  rankedDays,
  selectedMarkets,
  sourceRollup,
  sourcesWithEvents
} from "./queries.js"
import { applicationSchema, importRuns, sources, type DailyMetricRow, type ImportRunStatus } from "./schema.js"

const BATCH_SIZE = 250
const HIGH_VALUE_USD = 250
const MIGRATION_ID = "20260710_initial_etl_schema"

const initialPlan = {
  id: MIGRATION_ID,
  name: "initial ETL schema",
  operations: applicationSchema.map(tableToCreateOp)
} as const
const initialMigration = defineMigration({
  id: MIGRATION_ID,
  name: initialPlan.name,
  safety: "additive",
  phase: "expand",
  downSafety: "destructive",
  downPhase: "contract",
  up: { _tag: "SqlStatement", sql: compilePlan(initialPlan, SQLiteDialect) },
  down: {
    _tag: "SqlStatement",
    sql: "drop table if exists import_runs; drop table if exists daily_metrics; drop table if exists raw_events; drop table if exists sources;"
  }
})

const chunks = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const output: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

const metricId = (row: Pick<DailyMetricRow, "sourceId" | "day" | "eventType">): string =>
  `${row.sourceId}:${row.day}:${row.eventType}`

const migrate = Effect.gen(function* () {
  const migrator = yield* makeMigrator({
    migrations: [initialMigration],
    schema: applicationSchema,
    policy: "safe-only"
  })
  yield* migrator.check()
  yield* migrator.up()
  yield* migrator.check()
  const introspector = yield* makeIntrospector()
  const drift = yield* introspector.drift(applicationSchema)
  return { migrator, drift }
})

const seedSources = db
  .insert(sources)
  .values([
    { id: "store-na", name: "North America Store", region: "na", active: true },
    { id: "store-eu", name: "Europe Store", region: "eu", active: true },
    { id: "store-br", name: "Brazil Store", region: "latam", active: true }
  ])
  .onConflictDoUpdate([sources.id], {
    name: excluded(sources.name),
    region: excluded(sources.region),
    active: excluded(sources.active)
  })
  .run()

const refreshMetrics = db.transaction(
  Effect.gen(function* () {
    const grouped = yield* groupedMetrics.all()
    const highValue = yield* highValueMetrics.all({ threshold: HIGH_VALUE_USD })
    const highValueByKey = new Map(highValue.map((row) => [metricId(row), row.highValueCount]))
    const refreshedAt = new Date()

    yield* Effect.zipRight(
      clearDailyMetrics.execute(),
      Effect.forEach(
        grouped,
        (row) => {
          const id = metricId(row)
          return UpsertDailyMetric.execute({
            id,
            sourceId: row.sourceId,
            day: row.day,
            eventType: row.eventType,
            eventCount: row.eventCount,
            highValueCount: highValueByKey.get(id) ?? 0,
            grossUsd: Number(row.grossUsd.toFixed(2)),
            refreshedAt
          })
        },
        { discard: true }
      )
    )
    return grouped.length
  }),
  { sqliteMode: "immediate" }
)

export const runEtl = (inputPath: string) =>
  Effect.gen(function* () {
    const { migrator, drift } = yield* migrate
    yield* seedSources

    const run = yield* db
      .insert(importRuns)
      .values({
        fileName: inputPath,
        status: "running"
      })
      .returning({ id: importRuns.id, startedAt: importRuns.startedAt })
      .one()

    let rowsRead = 0
    let loaded = 0
    const execute = Effect.gen(function* () {
      const input = yield* readInput(inputPath, (line) => {
        rowsRead = Math.max(rowsRead, line)
      })
      const batches = chunks(input, BATCH_SIZE)
      for (const [index, batch] of batches.entries()) {
        yield* db.transaction(
          Effect.forEach(batch, (event) => UpsertRawEvent.execute(event), { discard: true }),
          { sqliteMode: "immediate" }
        )
        loaded += batch.length
        if ((index + 1) % 15 === 0 || index + 1 === batches.length) {
          yield* Console.log(`loaded ${loaded.toLocaleString()} / ${input.length.toLocaleString()} JSONL rows`)
        }
      }

      const metricGroups = yield* refreshMetrics
      yield* UpdateImportRun.execute({
        status: "completed" satisfies ImportRunStatus,
        rowsRead,
        rowsLoaded: loaded,
        finishedAt: new Date(),
        runId: run.id
      })

      const sample = yield* FindEvent.execute({ eventId: "evt-000042" })
      const rollup = yield* sourceRollup.all()
      const ranking = yield* rankedDays.all()
      const cte = yield* activeMetrics.all()
      const markets = yield* selectedMarkets.all()
      const correlated = yield* sourcesWithEvents.all()
      const rawJson = yield* partnerEvents.all()
      const database = yield* Database

      return {
        run,
        inputRows: rowsRead,
        loaded,
        metricGroups,
        sample,
        rollup,
        ranking,
        cte,
        markets,
        correlated,
        rawJson,
        migrationStatus: yield* migrator.status(),
        drift,
        cache: database.queryCache?.stats() ?? []
      }
    })

    const outcome = yield* Effect.exit(execute)
    if (Exit.isSuccess(outcome)) return outcome.value

    const finalization = yield* Effect.exit(
      Effect.asVoid(
        UpdateImportRun.execute({
          status: "failed" satisfies ImportRunStatus,
          rowsRead,
          rowsLoaded: loaded,
          finishedAt: new Date(),
          runId: run.id
        })
      )
    )
    if (Exit.isFailure(finalization)) {
      return yield* Effect.failCause(Cause.sequential(outcome.cause, finalization.cause))
    }
    return yield* Effect.failCause(outcome.cause)
  })
