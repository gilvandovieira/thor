/**
 * Effect-native database observability (v1 spec §17).
 *
 * @module observability
 */
import { Cause, Duration, Effect, Exit, Layer, Metric, Option } from "effect"
import { detectRuntimeCapabilities, type RuntimeId } from "../capabilities/runtime.js"
import type { DatabaseService } from "../execution/database.js"
import type { ParamNode, QueryIR } from "../ir/query-ir.js"
import { queryStructuralHash } from "../ir/structural-hash.js"
import { Database } from "../execution/database.js"

/** Parameter detail included in observability events and logs. */
export type ParameterLoggingMode = "none" | "redacted" | "unsafe-full"

/** SQL detail included in observability events and logs. */
export type SqlLoggingMode = "none" | "summary" | "unsafe-full"

/** Cache outcome recorded for one query execution. */
export type QueryCacheOutcome = "hit" | "miss" | "not-used"

/** Context propagated through transaction and migration scopes. */
export interface ObservabilityContext {
  /** Stable process-local transaction identifier. */
  readonly transactionId?: string
  /** Transaction nesting depth, where the outer transaction is `1`. */
  readonly transactionScope?: number
  /** Migration identifier when execution belongs to a migration. */
  readonly migrationId?: string
}

/** One parameter represented according to the configured logging mode. */
export interface ObservedParameter {
  /** Declared parameter name. */
  readonly name: string
  /** Redaction marker or, only in `unsafe-full` mode, the encoded value. */
  readonly value: unknown
}

/** Structured metadata emitted after an executed query. */
export interface QueryObservabilityEvent {
  /** Event discriminator. */
  readonly kind: "query"
  /** Lowercase query operation. */
  readonly operation: "select" | "insert" | "update" | "delete" | "call"
  /** Effect span name used for this execution. */
  readonly spanName: string
  /** Active SQL dialect identifier. */
  readonly dialect: string
  /** Detected JavaScript runtime. */
  readonly runtime: RuntimeId
  /** Tables referenced by the query shape. */
  readonly tables: ReadonlyArray<string>
  /** Dialect-independent, value-independent structural query hash. */
  readonly queryHash: string
  /** Whether dialect compilation was reused. */
  readonly compileCache: QueryCacheOutcome
  /** Whether a prepared identity was reused. */
  readonly preparedCache: QueryCacheOutcome
  /** End-to-end execution duration in milliseconds. */
  readonly durationMs: number
  /** Returned or affected row count, when execution produced one. */
  readonly rowCount?: number
  /** Tagged failure name, `Interrupted`, or `Defect`. */
  readonly errorTag?: string
  /** Stable process-local transaction identifier. */
  readonly transactionId?: string
  /** Transaction nesting depth. */
  readonly transactionScope?: number
  /** Migration identifier when the query belongs to a migration. */
  readonly migrationId?: string
  /** SQL summary or full SQL, according to `logSql`. */
  readonly sql?: string
  /** Parameters represented according to `logParams`. */
  readonly parameters?: ReadonlyArray<ObservedParameter>
}

/** Structured metadata emitted after a transaction or migration lifecycle operation. */
export interface LifecycleObservabilityEvent {
  /** Event discriminator. */
  readonly kind: "transaction" | "migration"
  /** Lifecycle operation such as `commit`, `rollback`, `apply`, or `drift`. */
  readonly operation: string
  /** Effect span name used for this operation. */
  readonly spanName: string
  /** Active SQL dialect identifier. */
  readonly dialect: string
  /** Detected JavaScript runtime. */
  readonly runtime: RuntimeId
  /** End-to-end operation duration in milliseconds. */
  readonly durationMs: number
  /** Tagged failure name, `Interrupted`, or `Defect`. */
  readonly errorTag?: string
  /** Stable process-local transaction identifier. */
  readonly transactionId?: string
  /** Transaction nesting depth. */
  readonly transactionScope?: number
  /** Migration identifier for migration lifecycle operations. */
  readonly migrationId?: string
}

/** Every structured event produced by Thor observability. */
export type ObservabilityEvent = QueryObservabilityEvent | LifecycleObservabilityEvent

/** @stable Opt-in observability configuration installed with {@link withObservability}. */
export interface ObservabilityOptions {
  /** Create Effect spans named `thor.*`. Defaults to `false`. */
  readonly tracing?: boolean
  /** Update Effect metrics for counts, rows, errors, and durations. Defaults to `false`. */
  readonly metrics?: boolean
  /** SQL logging detail. Defaults to `none`; full SQL is explicitly unsafe. */
  readonly logSql?: SqlLoggingMode
  /** Parameter logging detail. Defaults to `none`; raw values require `unsafe-full`. */
  readonly logParams?: ParameterLoggingMode
  /**
   * Optional synchronous sink for structured completed-operation metadata.
   *
   * @param event - Completed database operation metadata.
   * @returns Nothing.
   */
  readonly onEvent?: (event: ObservabilityEvent) => void
}

/** Normalized configuration retained by a database service. */
export interface ObservabilityConfig {
  /** Whether Effect tracing is enabled. */
  readonly tracing: boolean
  /** Whether Effect metrics are enabled. */
  readonly metrics: boolean
  /** SQL logging detail. */
  readonly logSql: SqlLoggingMode
  /** Parameter logging detail. */
  readonly logParams: ParameterLoggingMode
  /**
   * Optional structured event sink.
   *
   * @param event - Completed database operation metadata.
   * @returns Nothing.
   */
  readonly onEvent?: (event: ObservabilityEvent) => void
}

/** Mutable execution facts filled by the query pipeline before it completes. @internal */
export interface QueryObservationState {
  compileCache: QueryCacheOutcome
  preparedCache: QueryCacheOutcome
  compiledSql?: string
  paramOrder?: ReadonlyArray<ParamNode>
  values?: ReadonlyArray<unknown>
}

const runtime = detectRuntimeCapabilities().runtime
const operationCounter = Metric.counter("thor_operations_total", { incremental: true })
const errorCounter = Metric.counter("thor_operation_errors_total", { incremental: true })
const rowCounter = Metric.counter("thor_query_rows_total", { incremental: true })
const durationTimer = Metric.timer("thor_operation_duration", "Thor database operation duration")

/** @param metric - Metric to label. @param event - Label source. @returns The labeled metric. */
const tagged = <Type, In, Out>(metric: Metric.Metric<Type, In, Out>, event: ObservabilityEvent) =>
  Metric.tagged(Metric.tagged(Metric.tagged(metric, "kind", event.kind), "operation", event.operation), "dialect", event.dialect)

/** @param cause - Failed operation cause. @returns A safe error classification. */
const errorTag = <E>(cause: Cause.Cause<E>): string =>
  Option.match(Cause.failureOption(cause), {
    onNone: () => Cause.isInterrupted(cause) ? "Interrupted" : "Defect",
    onSome: (error) => {
      if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") {
        return error._tag
      }
      return "UnknownError"
    }
  })

/** @param exit - Completed Effect exit. @returns The original success or failure Effect. */
const replay = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)

/** @param config - Active configuration. @param event - Completed event. @returns An instrumentation Effect. */
const emit = (config: ObservabilityConfig, event: ObservabilityEvent): Effect.Effect<void> => {
  const effects: Array<Effect.Effect<void>> = []
  if (config.onEvent) {
    effects.push(Effect.sync(() => {
      try {
        config.onEvent!(event)
      } catch {
        // Instrumentation must never alter database behavior.
      }
    }))
  }
  if (config.logSql !== "none" || config.logParams !== "none") {
    effects.push(Effect.logDebug("thor.database", event))
  }
  if (config.metrics) {
    effects.push(Metric.increment(tagged(operationCounter, event)))
    effects.push(Metric.update(tagged(durationTimer, event), Duration.millis(event.durationMs)))
    if (event.errorTag) effects.push(Metric.increment(tagged(errorCounter, event)))
    if (event.kind === "query" && event.rowCount !== undefined) {
      effects.push(Metric.incrementBy(tagged(rowCounter, event), event.rowCount))
    }
  }
  return Effect.all(effects, { discard: true })
}

/** @param context - Active scope context. @returns Defined context event fields. */
const contextFields = (context: ObservabilityContext | undefined) => ({
  ...(context?.transactionId ? { transactionId: context.transactionId } : {}),
  ...(context?.transactionScope !== undefined ? { transactionScope: context.transactionScope } : {}),
  ...(context?.migrationId ? { migrationId: context.migrationId } : {})
})

/**
 * @param mode - Configured parameter detail.
 * @param args - Named execution arguments.
 * @param state - Bound positional execution state.
 * @returns Safely represented parameters, or `undefined` when disabled.
 */
const observedParameters = (
  mode: ParameterLoggingMode,
  args: Readonly<Record<string, unknown>>,
  state: QueryObservationState
): ReadonlyArray<ObservedParameter> | undefined => {
  if (mode === "none") return undefined
  const redact = mode === "redacted"
  if (state.paramOrder && state.values) {
    return state.paramOrder.map((parameter, index) => ({
      name: parameter.name,
      value: redact ? "[REDACTED]" : state.values![index]
    }))
  }
  return Object.entries(args).map(([name, value]) => ({ name, value: redact ? "[REDACTED]" : value }))
}

/**
 * Wrap a query pipeline with configured metadata, spans, logs, and metrics.
 *
 * @internal
 * @param database - Active database service.
 * @param ir - Executed query shape.
 * @param args - Named execution arguments.
 * @param state - Mutable execution facts scoped to this run.
 * @param effect - Query execution Effect.
 * @param rowCount - Successful result row-count extractor.
 * @returns The query Effect with opt-in instrumentation.
 */
export const observeQuery = <A, E, R>(
  database: DatabaseService,
  ir: QueryIR,
  args: Readonly<Record<string, unknown>>,
  state: QueryObservationState,
  effect: Effect.Effect<A, E, R>,
  rowCount: (value: A) => number | undefined
): Effect.Effect<A, E, R> => {
  const config = database.observability
  if (!config) return effect
  const operation = ir._tag.toLowerCase() as QueryObservabilityEvent["operation"]
  const tables = [...ir.annotations.tableNames]
  const spanName = `thor.query.${operation}.${tables[0] ?? "unknown"}`
  const initialAttributes = {
    "db.system": database.dialect.id,
    "db.operation.name": operation,
    "db.collection.names": tables.join(","),
    "thor.query.hash": queryStructuralHash(ir),
    ...ir.annotations.tracing?.attributes,
    ...contextFields(database.observabilityContext)
  }
  const observed = Effect.gen(function* () {
    const started = Date.now()
    const exit = yield* Effect.exit(effect)
    const durationMs = Math.max(0, Date.now() - started)
    const failure = Exit.isFailure(exit) ? errorTag(exit.cause) : undefined
    const rows = Exit.isSuccess(exit) ? rowCount(exit.value) : undefined
    const parameters = observedParameters(config.logParams, args, state)
    const sql = config.logSql === "unsafe-full"
      ? state.compiledSql
      : config.logSql === "summary"
      ? `${operation}${tables.length > 0 ? ` ${tables.join(",")}` : ""}`
      : undefined
    const event: QueryObservabilityEvent = {
      kind: "query",
      operation,
      spanName,
      dialect: database.dialect.id,
      runtime,
      tables,
      queryHash: queryStructuralHash(ir),
      compileCache: state.compileCache,
      preparedCache: state.preparedCache,
      durationMs,
      ...(rows !== undefined ? { rowCount: rows } : {}),
      ...(failure ? { errorTag: failure } : {}),
      ...contextFields(database.observabilityContext),
      ...(sql !== undefined ? { sql } : {}),
      ...(parameters ? { parameters } : {})
    }
    if (config.tracing) {
      yield* Effect.annotateCurrentSpan({
        "thor.duration_ms": durationMs,
        "db.response.returned_rows": event.rowCount ?? 0,
        "thor.cache.compile": event.compileCache,
        "thor.cache.prepared": event.preparedCache,
        ...(failure ? { "error.type": failure } : {})
      })
    }
    yield* emit(config, event)
    return exit
  })
  const completed = config.tracing
    ? Effect.withSpan(observed, spanName, { attributes: initialAttributes, kind: "client" })
    : observed
  // Replay outside the span so exporters receive only the sanitized error tag,
  // never the original Cause (which can contain driver or schema details).
  return Effect.flatMap(completed, replay)
}

/**
 * Wrap a transaction or migration lifecycle Effect with observability.
 *
 * @internal
 * @param database - Active database service.
 * @param kind - Transaction or migration event kind.
 * @param operation - Lifecycle operation name.
 * @param effect - Lifecycle Effect.
 * @param context - Optional transaction or migration scope context.
 * @returns The lifecycle Effect with opt-in instrumentation.
 */
export const observeLifecycle = <A, E, R>(
  database: DatabaseService,
  kind: LifecycleObservabilityEvent["kind"],
  operation: string,
  effect: Effect.Effect<A, E, R>,
  context: ObservabilityContext = database.observabilityContext ?? {}
): Effect.Effect<A, E, R> => {
  const config = database.observability
  if (!config) return effect
  const normalizedOperation = operation.replaceAll(" ", "-")
  const spanName = `thor.${kind}.${normalizedOperation}`
  const observed = Effect.gen(function* () {
    const started = Date.now()
    const exit = yield* Effect.exit(effect)
    const durationMs = Math.max(0, Date.now() - started)
    const failure = Exit.isFailure(exit) ? errorTag(exit.cause) : undefined
    const event: LifecycleObservabilityEvent = {
      kind,
      operation,
      spanName,
      dialect: database.dialect.id,
      runtime,
      durationMs,
      ...(failure ? { errorTag: failure } : {}),
      ...contextFields(context)
    }
    if (config.tracing) {
      yield* Effect.annotateCurrentSpan({
        "thor.duration_ms": durationMs,
        ...(failure ? { "error.type": failure } : {})
      })
    }
    yield* emit(config, event)
    return exit
  })
  const completed = config.tracing
    ? Effect.withSpan(observed, spanName, {
        attributes: { "db.system": database.dialect.id, ...contextFields(context) },
        kind: "client"
      })
    : observed
  return Effect.flatMap(completed, replay)
}

/**
 * Wrap a `Database` layer with opt-in tracing, metrics, and safe logging.
 *
 * @stable
 * @param layer - Base layer providing `Database`.
 * @param options - Observability options; raw SQL and parameters require explicit `unsafe-full` modes.
 * @returns A layer providing the observability-enabled database service.
 */
export const withObservability = <E, R>(
  layer: Layer.Layer<Database, E, R>,
  options: ObservabilityOptions = {}
): Layer.Layer<Database, E, R> =>
  Layer.effect(
    Database,
    Effect.map(Database, (database): DatabaseService => ({
      ...database,
      observability: {
        tracing: options.tracing ?? false,
        metrics: options.metrics ?? false,
        logSql: options.logSql ?? "none",
        logParams: options.logParams ?? "none",
        ...(options.onEvent ? { onEvent: options.onEvent } : {})
      }
    }))
  ).pipe(Layer.provide(layer))
