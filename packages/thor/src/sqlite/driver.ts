/**
 * Synchronous SQLite driver adapter supporting `node:sqlite` and compatible clients.
 *
 * @module sqlite/driver
 */
import { Effect, Layer } from "effect"
import { ConstraintError, DriverError } from "../errors/index.js"
import { Database, type DatabaseService } from "../execution/database.js"
import type { CommandResult, Driver, RawRow } from "../execution/driver.js"
import { SQLiteDialect } from "./dialect.js"
import {
  assertRuntimeCapabilities,
  defineRuntimeRequirements,
  detectRuntimeCapabilities,
  type RuntimeCapabilityProfile,
  type RuntimeRequirements
} from "../capabilities/runtime.js"

/** Runtime-neutral contract for a structurally compatible synchronous SQLite client. */
export const SQLiteDriverRuntime = defineRuntimeRequirements("sqlite/structural", [])

/** Runtime contract for Node's built-in `node:sqlite` client. */
export const NodeSQLiteDriverRuntime = defineRuntimeRequirements("sqlite/node", [
  "runtime.node",
  "runtime.sqlite.node"
])

/** Runtime contract for Bun's built-in `bun:sqlite` client. */
export const BunSQLiteDriverRuntime = defineRuntimeRequirements("sqlite/bun", [
  "runtime.bun",
  "runtime.sqlite.bun"
])

/** Minimal affected-row result returned by synchronous SQLite statements. */
export interface SQLiteRunResult {
  readonly changes: number | bigint
}

/** Primitive value accepted by SQLite positional binding. */
export type SQLiteValue = string | number | bigint | Uint8Array | null

/** Structural prepared-statement surface required by Thor. */
export interface SQLiteStatement {
  /**
   * @param params - Positional values.
   * @returns All raw result rows.
   */
  readonly all: (...params: ReadonlyArray<SQLiteValue>) => ReadonlyArray<RawRow>
  /**
   * @param params - Positional values.
   * @returns The affected-row result.
   */
  readonly run: (...params: ReadonlyArray<SQLiteValue>) => SQLiteRunResult
}

/** Structural subset shared by node:sqlite and better-sqlite3-style clients. */
export interface SQLiteClient {
  /**
   * @param sql - One SQL statement.
   * @returns A reusable prepared statement.
   */
  readonly prepare: (sql: string) => SQLiteStatement
  /**
   * @param sql - Parameter-free SQL script.
   * @returns Client-specific execution result.
   */
  readonly exec: (sql: string) => unknown
}

/** Synchronous acquisition/release hooks for an owned SQLite database. */
export interface SQLiteClientResource {
  /** @returns A newly opened SQLite client. */
  readonly acquire: () => SQLiteClient
  /** @param client - Acquired client to close. @returns Nothing. */
  readonly release: (client: SQLiteClient) => void
}

/**
 * @param code - Symbolic SQLite error code.
 * @param errcode - Numeric extended SQLite error code.
 * @param message - Native error message fallback.
 * @returns Normalized constraint kind when the failure is a constraint violation.
 */
const constraintKind = (
  code: string | undefined,
  errcode: number | undefined,
  message: string | undefined
): ConstraintError["kind"] | undefined => {
  if (errcode === 2067 || errcode === 1555 || code?.includes("UNIQUE") || code?.includes("PRIMARYKEY")) return "unique"
  if (errcode === 787 || code?.includes("FOREIGNKEY")) return "foreignKey"
  if (errcode === 275 || code?.includes("CHECK")) return "check"
  if (errcode === 1299 || code?.includes("NOTNULL")) return "notNull"
  if (!code?.startsWith("SQLITE_CONSTRAINT") && !message?.includes("constraint failed")) return undefined
  return "unknown"
}

/**
 * @param cause - Native SQLite failure.
 * @returns A normalized Thor driver error.
 */
const mapSQLiteError = (cause: unknown): DriverError | ConstraintError => {
  const error = cause as { readonly code?: string; readonly errcode?: number; readonly message?: string } | undefined
  const kind = constraintKind(error?.code, error?.errcode, error?.message)
  if (kind) {
    return new ConstraintError({
      kind,
      constraint: "unknown",
      message: error?.message ?? "SQLite constraint violation",
      cause
    })
  }
  return new DriverError({ message: error?.message ?? "SQLite driver error", cause })
}

/**
 * @param value - Application bind value.
 * @returns SQLite-compatible scalar.
 * @throws {TypeError} For unsupported values.
 */
const encodeValue = (value: unknown): SQLiteValue => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "boolean") return value ? 1 : 0
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return JSON.stringify(value)
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value
  }
  if (value instanceof Uint8Array) return value
  throw new TypeError(`Unsupported SQLite bind value: ${String(value)}`)
}

/**
 * Builds and validates a synchronous SQLite driver for a runtime contract.
 *
 * @param client - Synchronous SQLite client.
 * @param runtime - Adapter runtime requirements.
 * @param profile - Available runtime capabilities.
 * @returns A Thor driver with statement caching.
 * @throws {RuntimeCapabilityError} When the runtime contract is not satisfied.
 */
const makeDriver = (
  client: SQLiteClient,
  runtime: RuntimeRequirements,
  profile: RuntimeCapabilityProfile
): Driver => {
  assertRuntimeCapabilities(runtime, profile)
  const prepared = new Map<string, { readonly sql: string; readonly statement: SQLiteStatement }>()
  const statementFor = (sql: string, name?: string): SQLiteStatement => {
    if (!name) return client.prepare(sql)
    const cached = prepared.get(name)
    if (cached?.sql === sql) return cached.statement
    const statement = client.prepare(sql)
    if (!cached) prepared.set(name, { sql, statement })
    return statement
  }
  return {
    runtime,
    query: (sql, params, name) =>
      Effect.try({
        try: () => statementFor(sql, name).all(...params.map(encodeValue)),
        catch: mapSQLiteError
      }),
    execute: (sql, params, name) =>
      Effect.try({
        try: (): CommandResult => {
          const result = statementFor(sql, name).run(...params.map(encodeValue))
          return { rowCount: Number(result.changes) }
        },
        catch: mapSQLiteError
      }),
    executeScript: (sql) =>
      Effect.try({
        try: (): CommandResult => {
          client.exec(sql)
          return { rowCount: 0 }
        },
        catch: mapSQLiteError
      })
  }
}

/**
 * Creates a runtime-neutral driver for any structurally compatible synchronous
 * SQLite client.
 *
 * @param client - Synchronous SQLite client.
 * @returns A Thor driver with statement caching and no host-specific contract.
 */
export const makeSQLiteDriver = (client: SQLiteClient): Driver =>
  makeDriver(client, SQLiteDriverRuntime, detectRuntimeCapabilities())

/**
 * Creates a driver specifically bound to Node's built-in `node:sqlite` client.
 *
 * @param client - Node SQLite client.
 * @param profile - Runtime capabilities; defaults to host detection.
 * @returns A Thor SQLite driver declaring its Node runtime requirements.
 * @throws {RuntimeCapabilityError} When Node or `node:sqlite` is unavailable.
 */
export const makeNodeSQLiteDriver = (
  client: SQLiteClient,
  profile: RuntimeCapabilityProfile = detectRuntimeCapabilities()
): Driver => makeDriver(client, NodeSQLiteDriverRuntime, profile)

/**
 * Creates a driver specifically bound to Bun's built-in `bun:sqlite` client.
 *
 * @param client - Bun SQLite client.
 * @param profile - Runtime capabilities; defaults to host detection.
 * @returns A Thor SQLite driver declaring its Bun runtime requirements.
 * @throws {RuntimeCapabilityError} When Bun or `bun:sqlite` is unavailable.
 */
export const makeBunSQLiteDriver = (
  client: SQLiteClient,
  profile: RuntimeCapabilityProfile = detectRuntimeCapabilities()
): Driver => makeDriver(client, BunSQLiteDriverRuntime, profile)

/** Options shared by generic and runtime-specific SQLite layers. */
export interface SQLiteLayerOptions {
  /** Whether emulated SQL capabilities may execute. */
  readonly allowEmulation?: boolean
  /** Whether parameterized statements should be cached. */
  readonly preparedStatements?: boolean
  /** Optional runtime profile override for deterministic hosts and tests. */
  readonly runtime?: RuntimeCapabilityProfile
}

/**
 * Creates the Effect layer shared by SQLite adapter variants.
 *
 * @param driver - Validated SQLite driver.
 * @param options - Execution policy.
 * @returns An Effect layer providing `Database`.
 */
const sqliteLayer = (driver: Driver, options: SQLiteLayerOptions): Layer.Layer<Database> =>
  Layer.succeed(Database, {
    dialect: SQLiteDialect,
    driver,
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  } satisfies DatabaseService)

/**
 * @param client - Synchronous SQLite client.
 * @param options - Emulation and prepared-statement settings.
 * @returns An Effect layer providing a SQLite `Database`.
 */
export const SQLiteLayer = (
  client: SQLiteClient,
  options: SQLiteLayerOptions = {}
): Layer.Layer<Database> => sqliteLayer(makeSQLiteDriver(client), options)

/**
 * Creates a SQLite database layer bound to Node's built-in client.
 *
 * @param client - Node `DatabaseSync`-compatible client.
 * @param options - Execution policy and optional runtime override.
 * @returns An Effect layer providing `Database`.
 * @throws {RuntimeCapabilityError} When Node SQLite is unavailable.
 */
export const NodeSQLiteLayer = (
  client: SQLiteClient,
  options: SQLiteLayerOptions = {}
): Layer.Layer<Database> =>
  sqliteLayer(makeNodeSQLiteDriver(client, options.runtime ?? detectRuntimeCapabilities()), options)

/**
 * Creates a SQLite database layer bound to Bun's built-in client.
 *
 * @param client - Bun `Database`-compatible client.
 * @param options - Execution policy and optional runtime override.
 * @returns An Effect layer providing `Database`.
 * @throws {RuntimeCapabilityError} When Bun SQLite is unavailable.
 */
export const BunSQLiteLayer = (
  client: SQLiteClient,
  options: SQLiteLayerOptions = {}
): Layer.Layer<Database> =>
  sqliteLayer(makeBunSQLiteDriver(client, options.runtime ?? detectRuntimeCapabilities()), options)

/**
 * Creates an owned SQLite layer and closes it when the Effect scope ends.
 * @param resource - Synchronous database open/close hooks.
 * @param options - Execution and runtime settings.
 * @returns A scoped Database layer.
 */
export const SQLiteScopedLayer = (
  resource: SQLiteClientResource,
  options: SQLiteLayerOptions = {}
): Layer.Layer<Database, DriverError | ConstraintError> => Layer.scoped(
  Database,
  Effect.acquireRelease(
    Effect.try({ try: resource.acquire, catch: mapSQLiteError }),
    (client) => Effect.try({ try: () => resource.release(client), catch: mapSQLiteError }).pipe(Effect.orDie)
  ).pipe(Effect.map((client): DatabaseService => ({
    dialect: SQLiteDialect,
    driver: makeSQLiteDriver(client),
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  })))
)
