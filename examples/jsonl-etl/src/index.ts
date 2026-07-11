import { Cause, Console, Effect, Exit, Option } from "effect"
import { fileURLToPath } from "node:url"
import { ensureInputFile } from "./data.js"
import { makeDatabaseLayer, makeTelemetrySummary } from "./database.js"
import { runEtl } from "./etl.js"
import { featureTour } from "./feature-tour.js"

const inputPath = process.env.THOR_ETL_INPUT ?? fileURLToPath(new URL("../data/events.jsonl", import.meta.url))
const databasePath = process.env.THOR_ETL_DATABASE ?? fileURLToPath(new URL("../data/etl.sqlite", import.meta.url))
const generatedRows = Number(process.env.THOR_ETL_ROWS ?? 15_000)

const program = Effect.gen(function* () {
  yield* ensureInputFile(inputPath, generatedRows)
  const telemetry = makeTelemetrySummary()
  const result = yield* Effect.provide(runEtl(inputPath), makeDatabaseLayer(databasePath, telemetry))

  yield* Console.log("\nETL summary")
  yield* Console.log(
    JSON.stringify(
      {
        inputRows: result.inputRows,
        loaded: result.loaded,
        metricGroups: result.metricGroups,
        migrationStatus: result.migrationStatus.map(({ id, name, checksum }) => ({ id, name, checksum })),
        structuralDrift: { inSync: result.drift.inSync, changes: result.drift.changes },
        sample: Option.getOrNull(result.sample),
        sourceRollup: result.rollup,
        topRankedDays: result.ranking.slice(0, 5),
        cteRows: result.cte.slice(0, 3),
        selectedMarkets: result.markets,
        sourcesWithEvents: result.correlated,
        rawJsonRows: result.rawJson.length,
        cache: result.cache,
        telemetry
      },
      null,
      2
    )
  )

  yield* Console.log("\nCompile-only cross-dialect feature tour")
  yield* Console.log(JSON.stringify(featureTour(), null, 2))
})

Effect.runPromiseExit(Effect.scoped(program)).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause))
    process.exitCode = 1
  }
})
