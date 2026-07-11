/**
 * Promise-based MySQL driver adapter compatible with mysql2 connections.
 *
 * @module mysql/driver
 */
import { Effect, Layer } from "effect"
import { ConstraintError, DriverError } from "../errors/index.js"
import { Database, type DatabaseService } from "../execution/database.js"
import type { CommandResult, Driver, RawRow } from "../execution/driver.js"
import { MySQLDialect } from "./dialect.js"
import { assertRuntimeCapabilities, defineRuntimeRequirements } from "../capabilities/runtime.js"

/** Runtime-neutral contract for the structural mysql2-compatible adapter. */
export const MySQLDriverRuntime = defineRuntimeRequirements("mysql/mysql2-compatible", [])

/** Minimal mysql2 command result consumed by Thor. */
export interface MySQLResultHeader {
  readonly affectedRows: number
}

/** Row or command result returned by a MySQL client. */
export type MySQLResult = ReadonlyArray<RawRow> | MySQLResultHeader
/** Promise API tuple containing a result and driver-specific field metadata. */
export type MySQLQueryResult = readonly [unknown, unknown]

/** Structural subset of a mysql2 PromiseConnection or dedicated PoolConnection. */
export interface MySQLClient {
  /**
   * @param sql - SQL text.
   * @param params - Optional positional values.
   * @returns Result and field metadata.
   */
  readonly query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<MySQLQueryResult>
  /**
   * @param sql - Prepared SQL text.
   * @param params - Optional positional values.
   * @returns Result and field metadata.
   */
  readonly execute: (sql: string, params?: ReadonlyArray<unknown>) => Promise<MySQLQueryResult>
  /** @param sql - SQL text used as mysql2's cache key. @returns Nothing. */
  readonly unprepare?: (sql: string) => void
}

/** Acquisition/release hooks for an owned MySQL connection. */
export interface MySQLClientResource {
  /** @returns A newly connected, exclusively owned client. */
  readonly acquire: () => Promise<MySQLClient>
  /** @param client - Acquired client. @returns Completion of client cleanup. */
  readonly release: (client: MySQLClient) => Promise<void> | void
}

/** Dedicated connection returned by a mysql2-compatible pool. */
export interface MySQLPoolConnection extends MySQLClient {
  /** @returns Completion of returning the connection to its pool. */
  readonly release: () => Promise<void> | void
}

/** Pool surface used to acquire one affinity-safe connection. */
export interface MySQLPool {
  /** @returns One dedicated pool connection. */
  readonly getConnection: () => Promise<MySQLPoolConnection>
}

/**
 * @param errno - Numeric MySQL error code.
 * @param code - Symbolic MySQL error code.
 * @returns Normalized constraint kind.
 */
const constraintKind = (errno: number | undefined, code: string | undefined): ConstraintError["kind"] | undefined => {
  if (errno === 1062 || code === "ER_DUP_ENTRY") return "unique"
  if (errno === 1451 || errno === 1452 || code === "ER_NO_REFERENCED_ROW_2" || code === "ER_ROW_IS_REFERENCED_2") {
    return "foreignKey"
  }
  if (errno === 3819 || code === "ER_CHECK_CONSTRAINT_VIOLATED") return "check"
  if (errno === 1048 || code === "ER_BAD_NULL_ERROR") return "notNull"
  return undefined
}

/**
 * @param cause - Native MySQL client failure.
 * @returns A normalized constraint or driver error.
 */
export const mapMySQLDriverError = (cause: unknown): DriverError | ConstraintError => {
  const error = cause as
    | {
        readonly errno?: number
        readonly code?: string
        readonly sqlState?: string
        readonly message?: string
      }
    | undefined
  const kind = constraintKind(error?.errno, error?.code)
  if (kind) {
    return new ConstraintError({
      kind,
      constraint: "unknown",
      message: error?.message ?? `MySQL constraint violation (${error?.sqlState ?? error?.code ?? "unknown"})`,
      cause
    })
  }
  return new DriverError({ message: error?.message ?? "MySQL driver error", cause })
}

/**
 * @param value - Application bind value.
 * @returns mysql2-compatible scalar or serialized JSON.
 */
const encodeValue = (value: unknown): unknown => {
  // mysql2 `execute()` rejects `undefined` binds while `query()` escapes them
  // as NULL; normalize so both call paths behave identically.
  if (value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value)
  }
  return value
}

/** Per-connection prepared-name → SQL registry (survives driver re-creation on pool leases). */
const preparedByClient = new WeakMap<object, Map<string, string>>()

/**
 * @param result - First mysql2 result tuple element.
 * @returns Raw rows.
 * @throws {TypeError} For command results.
 */
const rowsOf = (result: unknown): ReadonlyArray<RawRow> => {
  if (!Array.isArray(result)) throw new TypeError("MySQL query did not return rows")
  return result as ReadonlyArray<RawRow>
}

/**
 * @param result - First mysql2 result tuple element.
 * @returns Normalized affected-row count.
 * @throws {TypeError} For unknown shapes.
 */
const rowCountOf = (result: unknown): number => {
  if (Array.isArray(result)) return result.length
  if (typeof result === "object" && result !== null && "affectedRows" in result) {
    return Number((result as MySQLResultHeader).affectedRows)
  }
  throw new TypeError("MySQL command did not return an affected-row count")
}

/**
 * @param client - mysql2-compatible promise client.
 * @returns A Thor MySQL driver.
 */
export const makeMySQLDriver = (client: MySQLClient): Driver => {
  assertRuntimeCapabilities(MySQLDriverRuntime)
  let registry = preparedByClient.get(client)
  if (!registry) {
    registry = new Map<string, string>()
    preparedByClient.set(client, registry)
  }
  const prepared = registry
  const call = (sql: string, params: ReadonlyArray<unknown>, name?: string) => {
    const priorSql = name ? prepared.get(name) : undefined
    const usePrepared = name !== undefined && (priorSql === undefined || priorSql === sql)
    if (name && priorSql === undefined) prepared.set(name, sql)
    return usePrepared
      ? client.execute(sql, params.map(encodeValue))
      : params.length > 0
        ? client.query(sql, params.map(encodeValue))
        : client.query(sql)
  }
  return {
    runtime: MySQLDriverRuntime,
    preparedScope: client,
    query: (sql, params, name) =>
      Effect.tryPromise({
        try: async () => rowsOf((await call(sql, params, name))[0]),
        catch: mapMySQLDriverError
      }),
    execute: (sql, params, name) =>
      Effect.tryPromise({
        try: async (): Promise<CommandResult> => ({
          rowCount: rowCountOf((await call(sql, params, name))[0])
        }),
        catch: mapMySQLDriverError
      }),
    executeScript: (sql) =>
      Effect.tryPromise({
        try: async (): Promise<CommandResult> => ({ rowCount: rowCountOf((await client.query(sql))[0]) }),
        catch: mapMySQLDriverError
      }),
    releasePrepared: (name) =>
      Effect.try({
        try: () => {
          const sql = prepared.get(name)
          if (!sql) return
          prepared.delete(name)
          client.unprepare?.(sql)
        },
        catch: mapMySQLDriverError
      }),
    clearPrepared: () =>
      Effect.try({
        try: () => {
          if (client.unprepare) for (const sql of prepared.values()) client.unprepare(sql)
          prepared.clear()
        },
        catch: mapMySQLDriverError
      })
  }
}

/**
 * @param client - Dedicated mysql2 connection or pool connection.
 * @param options - Emulation and prepared-statement settings.
 * @returns An Effect layer providing a MySQL `Database`.
 */
export const MySQLLayer = (
  client: MySQLClient,
  options: { readonly allowEmulation?: boolean; readonly preparedStatements?: boolean } = {}
): Layer.Layer<Database> =>
  Layer.succeed(Database, {
    dialect: MySQLDialect,
    driver: makeMySQLDriver(client),
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  } satisfies DatabaseService)

/**
 * Creates an owned MySQL layer whose connection is always released.
 * @param resource - Client acquisition and release hooks.
 * @param options - Emulation and prepared-statement settings.
 * @returns A scoped Database layer.
 */
export const MySQLScopedLayer = (
  resource: MySQLClientResource,
  options: { readonly allowEmulation?: boolean; readonly preparedStatements?: boolean } = {}
): Layer.Layer<Database, DriverError | ConstraintError> =>
  Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.tryPromise({ try: resource.acquire, catch: mapMySQLDriverError }).pipe(
        Effect.map((client) => ({ client, driver: makeMySQLDriver(client) }))
      ),
      ({ client, driver }) =>
        (driver.clearPrepared?.() ?? Effect.void).pipe(
          Effect.orDie,
          Effect.ensuring(
            Effect.tryPromise({
              try: async () => resource.release(client),
              catch: mapMySQLDriverError
            }).pipe(Effect.orDie)
          )
        )
    ).pipe(
      Effect.map(
        ({ driver }): DatabaseService => ({
          dialect: MySQLDialect,
          driver,
          allowEmulation: options.allowEmulation ?? false,
          preparedStatements: options.preparedStatements ?? true
        })
      )
    )
  )

/**
 * Acquires one dedicated mysql2 pool connection for the layer lifetime. This is
 * intentionally not an application-wide per-operation pool: all queries and
 * nested transactions provided by the layer share this one physical connection.
 * @param pool - mysql2-compatible pool.
 * @param options - Emulation and prepared-statement settings.
 * @returns A scoped Database layer.
 */
export const MySQLDedicatedPoolConnectionLayer = (
  pool: MySQLPool,
  options: { readonly allowEmulation?: boolean; readonly preparedStatements?: boolean } = {}
) =>
  MySQLScopedLayer(
    {
      acquire: () => pool.getConnection(),
      release: (client) => (client as MySQLPoolConnection).release()
    },
    options
  )
