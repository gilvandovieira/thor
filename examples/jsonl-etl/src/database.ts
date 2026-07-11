import { DatabaseSync } from "node:sqlite"
import { db, SQLiteScopedLayer, type ObservabilityEvent } from "@gilvandovieira/thor"

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

export const makeDatabaseLayer = (path: string, telemetry: TelemetrySummary) => {
  const sqlite = SQLiteScopedLayer({
    acquire: () => {
      const client = new DatabaseSync(path)
      try {
        client.exec("pragma foreign_keys = on")
        client.exec("pragma journal_mode = wal")
        client.exec("pragma synchronous = normal")
        return client
      } catch (cause) {
        client.close()
        throw cause
      }
    },
    release: (client) => (client as DatabaseSync).close()
  })
  const cached = db.withQueryCache(sqlite, { maxSize: 2_000, strategy: "lru" })
  return db.withObservability(cached, {
    tracing: true,
    metrics: true,
    logSql: "summary",
    logParams: "redacted",
    onEvent: (event) => record(telemetry, event)
  })
}
