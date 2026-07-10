/**
 * Transaction-scoped database execution with nested savepoints.
 *
 * @module execution/transaction
 */
import { Cause, Effect, Exit } from "effect"
import { TransactionError } from "../errors/index.js"
import { Database, type DatabaseService } from "./database.js"
import { observeLifecycle } from "../observability/index.js"

/** Isolation levels supported by Thor's transaction API. */
export type TransactionIsolationLevel = "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable"

/** Deliberate retry policy. Retries never happen unless this is supplied. */
export interface TransactionRetryPolicy<E = unknown> {
  /** Maximum number of fresh outer-transaction attempts after the first failure. */
  readonly times: number
  /**
   * @param error - Typed body or transaction lifecycle failure.
   * @returns Whether it is safe for the application to replay the whole body.
   */
  readonly while: (error: E | TransactionError) => boolean
}

/** Options for one outer transaction or nested savepoint. */
export interface TransactionOptions<E = unknown> {
  /** Backend transaction isolation level. */
  readonly isolationLevel?: TransactionIsolationLevel
  /** Read/write intent where supported by the backend. */
  readonly accessMode?: "read-only" | "read-write"
  /** SQLite begin mode; ignored by PostgreSQL and MySQL. */
  readonly sqliteMode?: "deferred" | "immediate" | "exclusive"
  /** Explicit outer retry boundary. Nested transactions cannot retry independently. */
  readonly retry?: TransactionRetryPolicy<E>
}

interface TransactionState {
  readonly id: string
  readonly depth: number
  readonly nextSavepoint: { value: number }
}

type TransactionDatabaseService = DatabaseService & {
  readonly transactionState?: TransactionState
}

/**
 * Whether the active service is executing inside a transaction (outer or nested
 * savepoint). Used to honor a procedure's `requiresTransaction` metadata (§14.5).
 *
 * @param database - Active database service.
 * @returns `true` when a transaction scope is present.
 */
export const isInTransaction = (database: DatabaseService): boolean =>
  (database as TransactionDatabaseService).transactionState !== undefined

/** @param phase - Lifecycle phase. @returns A native-error mapper for that phase. */
const transactionError =
  (phase: string) =>
  (cause: { readonly message?: string }): TransactionError =>
    new TransactionError({ message: `Transaction ${phase} failed: ${cause.message ?? String(cause)}`, cause })

/** @param database - Active service. @param sql - Lifecycle SQL. @param phase - Diagnostic phase. @returns A void lifecycle Effect. */
const lifecycle = (database: DatabaseService, sql: string, phase: string) =>
  observeLifecycle(
    database,
    "transaction",
    phase,
    database.driver.execute(sql, []).pipe(Effect.mapError(transactionError(phase)), Effect.asVoid)
  )

let transactionCounter = 0

/**
 * @param database - Active database service.
 * @param options - Outer transaction options.
 * @returns Ordered statements required to start the transaction.
 */
const outerStart = (
  database: DatabaseService,
  options: Pick<TransactionOptions<never>, "isolationLevel" | "accessMode" | "sqliteMode">
): ReadonlyArray<readonly [sql: string, phase: string]> =>
  database.dialect.transactions
    .begin({
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      ...(options.accessMode ? { accessMode: options.accessMode } : {}),
      ...(options.sqliteMode ? { beginMode: options.sqliteMode } : {})
    })
    .map(({ sql, phase }) => [sql, phase] as const)

/**
 * @param bodyCause - Original body failure cause.
 * @param cleanup - Rollback cleanup effect.
 * @returns The original failure, sequentially composed with cleanup failure.
 */
const finishAfterFailure = <A, E>(
  bodyCause: Cause.Cause<E>,
  cleanup: Effect.Effect<void, TransactionError>
): Effect.Effect<A, E | TransactionError> =>
  Effect.gen(function* () {
    const cleanupExit = yield* Effect.exit(cleanup)
    if (Exit.isFailure(cleanupExit)) {
      return yield* Effect.failCause(Cause.sequential(bodyCause, cleanupExit.cause))
    }
    return yield* Effect.failCause(bodyCause)
  })

/**
 * Runs an Effect against a specific database service inside a transaction.
 * Nested calls use savepoints and the same driver connection.
 *
 * @param database - Database service owning the affinity-safe driver.
 * @param body - Effect to run with a transaction-scoped Database service.
 * @param options - Isolation, access, SQLite, and retry policy.
 * @returns The body result or its typed/lifecycle failure.
 */
export const runTransaction = <A, E, R>(
  database: DatabaseService,
  body: Effect.Effect<A, E, R>,
  options: TransactionOptions<E> = {}
) => {
  const current = (database as TransactionDatabaseService).transactionState
  if (current && options.retry) {
    return Effect.fail(
      new TransactionError({ message: "Nested transactions cannot define an independent retry policy" })
    )
  }

  const once = (): Effect.Effect<A, E | TransactionError, Exclude<R, Database>> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (current) {
          const name = `thor_sp_${++current.nextSavepoint.value}`
          const nestedDatabase: TransactionDatabaseService = {
            ...database,
            transactionState: { id: current.id, depth: current.depth + 1, nextSavepoint: current.nextSavepoint },
            observabilityContext: {
              ...database.observabilityContext,
              transactionId: current.id,
              transactionScope: current.depth + 1
            }
          }
          yield* lifecycle(nestedDatabase, `savepoint ${name}`, "savepoint")
          const bodyExit = yield* Effect.exit(restore(Effect.provideService(body, Database, nestedDatabase)))
          if (Exit.isSuccess(bodyExit)) {
            yield* lifecycle(nestedDatabase, `release savepoint ${name}`, "savepoint release")
            return bodyExit.value
          }
          return yield* finishAfterFailure<A, E>(
            bodyExit.cause,
            lifecycle(nestedDatabase, `rollback to savepoint ${name}`, "savepoint rollback").pipe(
              Effect.zipRight(lifecycle(nestedDatabase, `release savepoint ${name}`, "savepoint release"))
            )
          )
        }

        const start = yield* Effect.try({
          try: () => outerStart(database, options),
          catch: (cause) =>
            cause instanceof TransactionError
              ? cause
              : new TransactionError({ message: "Transaction options are invalid", cause })
        })
        const transactionId = `tx-${++transactionCounter}`
        const transactionDatabase: TransactionDatabaseService = {
          ...database,
          transactionState: { id: transactionId, depth: 1, nextSavepoint: { value: 0 } },
          observabilityContext: {
            ...database.observabilityContext,
            transactionId,
            transactionScope: 1
          }
        }
        for (const [sql, phase] of start) yield* lifecycle(transactionDatabase, sql, phase)
        const bodyExit = yield* Effect.exit(restore(Effect.provideService(body, Database, transactionDatabase)))
        if (Exit.isSuccess(bodyExit)) {
          yield* lifecycle(transactionDatabase, database.dialect.migrations.commitTransaction ?? "commit", "commit")
          return bodyExit.value
        }
        return yield* finishAfterFailure<A, E>(
          bodyExit.cause,
          lifecycle(transactionDatabase, database.dialect.migrations.rollbackTransaction ?? "rollback", "rollback")
        )
      })
    )

  const retry = options.retry
  if (!retry || retry.times <= 0) return once()
  const attempt = (remaining: number): Effect.Effect<A, E | TransactionError, Exclude<R, Database>> =>
    once().pipe(
      Effect.catchAll((error) => (remaining > 0 && retry.while(error) ? attempt(remaining - 1) : Effect.fail(error)))
    )
  return attempt(retry.times)
}

/**
 * Runs an Effect in a transaction using the ambient `Database` service.
 * The body receives a transaction-scoped `Database`, so nested calls become savepoints.
 *
 * @param body - Effect to run inside the boundary.
 * @param options - Isolation, access, SQLite, and retry policy.
 * @returns An Effect requiring the ambient Database service.
 */
export const transaction = <A, E, R>(body: Effect.Effect<A, E, R>, options: TransactionOptions<E> = {}) =>
  Effect.flatMap(Database, (database) => runTransaction(database, body, options))
