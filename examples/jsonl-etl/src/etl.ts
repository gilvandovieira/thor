import { Console, Effect } from "effect"
import { Database, db, excluded } from "@gilvandovieira/thor"
import { makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { readInput } from "./data.js"
import {
  FindEvent,
  FinishImportRun,
  UpsertDailyMetric,
  UpsertRawEvent,
  activeMetrics,
  deleteStaleMetrics,
  groupedMetrics,
  highValueMetrics,
  partnerEvents,
  rankedDays,
  selectedMarkets,
  sourceRollup,
  sourcesWithEvents
} from "./queries.js"
import { applicationSchema, importRuns, sources, type DailyMetricRow } from "./schema.js"

const BATCH_SIZE = 250
const HIGH_VALUE_USD = 250
const MIGRATION_ID = "20260710_initial_etl_schema"

const chunks = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const output: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

const metricId = (row: Pick<DailyMetricRow, "sourceId" | "day" | "eventType">): string =>
  `${row.sourceId}:${row.day}:${row.eventType}`

const migrate = Effect.gen(function* () {
  const migrator = yield* makeMigrator({ schema: applicationSchema, policy: "safe-only" })
  const status = yield* migrator.status()
  if (!status.some((entry) => entry.id === MIGRATION_ID)) {
    yield* migrator.apply({
      id: MIGRATION_ID,
      name: "initial ETL schema",
      operations: applicationSchema.map(tableToCreateOp)
    })
  }
  const drift = yield* migrator.drift()
  return { migrator, drift }
})

const seedSources = db.insert(sources).values([
  { id: "store-na", name: "North America Store", region: "na", active: true },
  { id: "store-eu", name: "Europe Store", region: "eu", active: true },
  { id: "store-br", name: "Brazil Store", region: "latam", active: true }
]).onConflictDoUpdate([sources.id], {
  name: excluded(sources.name),
  region: excluded(sources.region),
  active: excluded(sources.active)
}).run()

const refreshMetrics = Effect.gen(function* () {
  const grouped = yield* groupedMetrics.all()
  const highValue = yield* highValueMetrics.all({ threshold: HIGH_VALUE_USD })
  const highValueByKey = new Map(highValue.map((row) => [metricId(row), row.highValueCount]))
  const refreshedAt = new Date()

  yield* db.transaction(Effect.forEach(grouped, (row) => {
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
  }, { discard: true }), { sqliteMode: "immediate" })

  // This is intentionally a no-op for the generated fixture, but demonstrates
  // parameterized DELETE and keeps reruns from retaining an obsolete horizon.
  yield* deleteStaleMetrics.run({ before: "2026-01-01" })
  return grouped.length
})

export const runEtl = (inputPath: string) => Effect.gen(function* () {
  const { migrator, drift } = yield* migrate
  yield* seedSources

  const run = yield* db.insert(importRuns).values({
    fileName: inputPath,
    status: "running"
  }).returning({ id: importRuns.id, startedAt: importRuns.startedAt }).one()

  const input = yield* readInput(inputPath)
  const batches = chunks(input, BATCH_SIZE)
  let loaded = 0
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
  yield* FinishImportRun.execute({
    status: "completed",
    rowsRead: input.length,
    rowsLoaded: loaded,
    finishedAt: new Date(),
    runId: run.id
  })

  const sample = yield* FindEvent.maybeOne({ eventId: "evt-000042" })
  const rollup = yield* sourceRollup.all()
  const ranking = yield* rankedDays.all()
  const cte = yield* activeMetrics.all()
  const markets = yield* selectedMarkets.all()
  const correlated = yield* sourcesWithEvents.all()
  const rawJson = yield* partnerEvents.all()
  const database = yield* Database

  return {
    run,
    inputRows: input.length,
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
