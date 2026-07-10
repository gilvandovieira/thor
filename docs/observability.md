# Observability

Thor exposes query, transaction, and migration behavior through Effect spans,
metrics, structured logs, and an optional event sink. Instrumentation is opt-in
at the database layer:

```ts
import { db } from "@gilvandovieira/thor"

const ObservedDatabase = db.withObservability(DatabaseLive, {
  tracing: true,
  metrics: true,
  logSql: "summary",
  logParams: "redacted"
})
```

`withObservability` is also exported directly from the package root and from
`@gilvandovieira/thor/observability`.

## Query Metadata

Every observed query produces a `QueryObservabilityEvent` after execution. It
contains the operation, dialect, detected runtime, table names, value-independent
query hash, compile and prepared cache outcomes, duration, row count, tagged
failure, and transaction or migration context. `onEvent` provides this structure
to application telemetry without requiring a particular exporter:

```ts
const ObservedDatabase = db.withObservability(DatabaseLive, {
  onEvent: (event) => telemetry.record(event)
})
```

Event sinks are diagnostic only. If a sink throws, Thor ignores that exception
and preserves the database Effect's original success, failure, or interruption.

## Spans And Metrics

With `tracing: true`, Thor creates Effect spans with stable names:

```txt
thor.query.select.users
thor.query.insert.posts
thor.transaction.commit
thor.transaction.rollback
thor.migration.apply
thor.migration.drift
```

Query spans carry dialect, operation, tables, structural hash, cache outcomes,
row count, error tag, and transaction/migration context. With `metrics: true`,
Thor updates Effect metrics named `thor_operations_total`,
`thor_operation_errors_total`, `thor_query_rows_total`, and
`thor_operation_duration`, tagged by operation kind, operation, and dialect.

## Safe Logging

Raw values are never included by default. Logging has explicit independent
modes:

| Option | Modes | Default |
|---|---|---|
| `logSql` | `none`, `summary`, `unsafe-full` | `none` |
| `logParams` | `none`, `redacted`, `unsafe-full` | `none` |

`summary` reports only the operation and table names. `redacted` reports
parameter names with `[REDACTED]` values. Both `unsafe-full` modes are visibly
named opt-ins because full SQL or encoded parameter values can contain secrets.

The query hash, cache identities, span attributes, and default structured events
remain value-independent. Enabling tracing or metrics alone does not expose SQL
or parameter values.

## Testing and cost

Use an `onEvent` collector with `FakeDatabaseLayer` to assert metadata and the
default no-secrets invariant without requiring a telemetry backend:

```ts
const events: ObservabilityEvent[] = []
const layer = withObservability(FakeDatabaseLayer(driver), {
  onEvent: (event) => events.push(event)
})

await Effect.runPromise(query.pipe(Effect.provide(layer)))
expect(events[0]).toMatchObject({ dialect: "postgres", operation: "select" })
```

Instrumentation is opt-in and adds span, metric, logging, or event-sink work at
the execution boundary. Event sinks should stay non-blocking and avoid expensive
serialization on hot paths. Benchmark the enabled configuration used in
production; the default disabled path does not construct telemetry payloads.
