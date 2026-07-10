import { Console, Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { ensureInputFile } from "./data.js"
import { makeDatabaseLayer, makeTelemetrySummary } from "./database.js"
import { runEtl } from "./etl.js"
import { featureTour } from "./feature-tour.js"

const inputPath = fileURLToPath(new URL("../data/events.jsonl", import.meta.url))
const databasePath = fileURLToPath(new URL("../data/etl.sqlite", import.meta.url))

const openDatabase = Effect.acquireRelease(
  Effect.sync(() => {
    const client = new DatabaseSync(databasePath)
    client.exec("pragma foreign_keys = on")
    client.exec("pragma journal_mode = wal")
    client.exec("pragma synchronous = normal")
    return client
  }),
  (client) => Effect.sync(() => client.close())
)

const program = Effect.gen(function* () {
  yield* ensureInputFile(inputPath)
  const telemetry = makeTelemetrySummary()
  const client = yield* openDatabase
  const result = yield* Effect.provide(runEtl(inputPath), makeDatabaseLayer(client, telemetry))

  yield* Console.log("\nETL summary")
  yield* Console.log(JSON.stringify({
    inputRows: result.inputRows,
    loaded: result.loaded,
    metricGroups: result.metricGroups,
    migrationDrift: result.drift.length,
    sample: result.sample,
    sourceRollup: result.rollup,
    topRankedDays: result.ranking.slice(0, 5),
    cteRows: result.cte.slice(0, 3),
    selectedMarkets: result.markets,
    sourcesWithEvents: result.correlated,
    rawJsonRows: result.rawJson.length,
    cache: result.cache,
    telemetry
  }, null, 2))

  yield* Console.log("\nCompile-only cross-dialect feature tour")
  yield* Console.log(JSON.stringify(featureTour(), null, 2))
})

Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  console.error(cause)
  process.exitCode = 1
})
