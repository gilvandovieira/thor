import type { DatabaseSync } from "node:sqlite"
import { db, NodeSQLiteLayer, type ObservabilityEvent } from "@gilvandovieira/thor"

export interface TelemetrySummary {
  queries: number
  transactions: number
  migrations: number
  failures: number
}

export const makeTelemetrySummary = (): TelemetrySummary => ({
  queries: 0,
  transactions: 0,
  migrations: 0,
  failures: 0
})

const record = (summary: TelemetrySummary, event: ObservabilityEvent): void => {
  if (event.kind === "query") summary.queries++
  if (event.kind === "transaction") summary.transactions++
  if (event.kind === "migration") summary.migrations++
  if (event.errorTag) summary.failures++
}

export const makeDatabaseLayer = (client: DatabaseSync, telemetry: TelemetrySummary) => {
  const cached = db.withQueryCache(NodeSQLiteLayer(client), { maxSize: 2_000, strategy: "lru" })
  const observed = db.withObservability(cached, {
    tracing: true,
    metrics: true,
    logSql: "summary",
    logParams: "redacted",
    onEvent: (event) => record(telemetry, event)
  })
  return db.withMode(observed, "trusted")
}
