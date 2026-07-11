/**
 * postgres.js driver adapter — a second Postgres client behind the same
 * `Driver` contract (spec §14.10). Proves the driver seam is client-agnostic:
 * node-postgres and postgres.js pass the identical contract suite.
 *
 * Because the migrator/transactions issue `begin`/`commit` and advisory locks
 * on a single connection, back this with a single-connection instance
 * (`postgres(url, { max: 1 })`).
 *
 * @module postgres/postgres-js
 */
import { Effect, Layer } from "effect"
import type { CommandResult, Driver, RawRow } from "../execution/driver.js"
import { Database, type DatabaseService } from "../execution/database.js"
import { PostgresDialect } from "./dialect.js"
import { mapDriverError } from "./errors.js"
import { assertRuntimeCapabilities, defineRuntimeRequirements } from "../capabilities/runtime.js"

/** Runtime-neutral contract for the structural postgres.js adapter. */
export const PostgresJsDriverRuntime = defineRuntimeRequirements("postgres/postgres-js", [])

/** A postgres.js result is a row array with a `count` property. */
export interface PostgresJsResult extends ReadonlyArray<RawRow> {
  readonly count: number
}

/** A postgres.js pending query — thenable, with `.simple()` for multi-statement SQL. */
export interface PostgresJsPending extends PromiseLike<PostgresJsResult> {
  /** @returns The result executed through PostgreSQL's simple protocol. */
  simple: () => PromiseLike<PostgresJsResult>
  /** @param rows - Requested batch size. @param callback - Batch consumer returning `CLOSE`. @returns Cursor completion. */
  cursor?: (rows: number, callback: (rows: ReadonlyArray<RawRow>) => unknown) => PromiseLike<unknown>
}

/** postgres.js `unsafe` query options. */
export interface PostgresJsUnsafeOptions {
  readonly prepare?: boolean
}

/** The slice of a postgres.js `sql` instance Thor needs. */
export interface PostgresJsClient {
  /** postgres.js early-cursor-close token. */
  readonly CLOSE?: unknown
  /**
   * @param query - SQL text.
   * @param params - Optional positional values.
   * @param options - Optional postgres.js execution settings.
   * @returns A pending postgres.js query.
   */
  unsafe: (query: string, params?: ReadonlyArray<unknown>, options?: PostgresJsUnsafeOptions) => PostgresJsPending
}

/**
 * postgres.js uses the extended protocol whenever parameters are present, which
 * forbids multiple statements. Param-free statements (migration DDL) go through
 * `.simple()` to allow multi-statement scripts. When a prepared name is
 * requested, `{ prepare: true }` opts the query into postgres.js's
 * prepared-statement cache — keyed internally by the query text, so it is
 * collision-safe by construction.
 *
 * @param client - Structural postgres.js client.
 * @param sql - SQL text to execute.
 * @param params - Positional bind values.
 * @param prepared - Whether postgres.js should prepare the statement.
 * @returns A thenable postgres.js result.
 */
const call = (
  client: PostgresJsClient,
  sql: string,
  params: ReadonlyArray<unknown>,
  prepared: boolean
): PromiseLike<PostgresJsResult> =>
  params.length > 0 ? client.unsafe(sql, params, prepared ? { prepare: true } : undefined) : client.unsafe(sql).simple()

/**
 * Reads at most `maxRows` through a postgres.js cursor and closes immediately.
 * Missing cursor support rejects instead of silently materializing an unbounded
 * DML `RETURNING` result.
 *
 * @param client - Structural postgres.js client.
 * @param sql - SQL text.
 * @param params - Positional values.
 * @param prepared - Whether postgres.js may prepare the query.
 * @param maxRows - Hard row-read bound.
 * @returns At most `maxRows` rows.
 */
const callBounded = async (
  client: PostgresJsClient,
  sql: string,
  params: ReadonlyArray<unknown>,
  prepared: boolean,
  maxRows: number
): Promise<ReadonlyArray<RawRow>> => {
  const pending = client.unsafe(sql, params, prepared ? { prepare: true } : undefined)
  if (!pending.cursor || client.CLOSE === undefined) {
    throw new TypeError("postgres.js bounded row probes require the cursor API and CLOSE token")
  }
  const rows: RawRow[] = []
  await pending.cursor(maxRows, (batch) => {
    rows.push(...batch.slice(0, maxRows - rows.length))
    return client.CLOSE
  })
  return rows
}

/**
 * @param client - Structural postgres.js client.
 * @returns A Thor PostgreSQL driver.
 */
export const makePostgresJsDriver = (client: PostgresJsClient): Driver => {
  assertRuntimeCapabilities(PostgresJsDriverRuntime)
  return {
    runtime: PostgresJsDriverRuntime,
    preparedScope: client,
    query: (sql, params, name, maxRows) =>
      Effect.tryPromise({
        try: () =>
          maxRows === undefined
            ? Promise.resolve(call(client, sql, params, name !== undefined)).then(
                (rows): ReadonlyArray<RawRow> => Array.from(rows)
              )
            : callBounded(client, sql, params, name !== undefined, maxRows),
        catch: mapDriverError
      }),
    execute: (sql, params, name) =>
      Effect.tryPromise({ try: () => call(client, sql, params, name !== undefined), catch: mapDriverError }).pipe(
        Effect.map((res): CommandResult => ({ rowCount: res.count ?? res.length ?? 0 }))
      ),
    executeScript: (sql) =>
      Effect.tryPromise({ try: () => client.unsafe(sql).simple(), catch: mapDriverError }).pipe(
        Effect.map((res): CommandResult => ({ rowCount: res.count ?? res.length ?? 0 }))
      )
  }
}

/**
 * Creates a PostgreSQL layer backed by postgres.js.
 *
 * @param client - Single-connection postgres.js client for migration safety.
 * @param options - Emulation and prepared-statement settings.
 * @returns An Effect layer providing `Database`.
 */
export const PostgresJsLayer = (
  client: PostgresJsClient,
  options: { readonly allowEmulation?: boolean; readonly preparedStatements?: boolean } = {}
): Layer.Layer<Database> =>
  Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: makePostgresJsDriver(client),
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  } satisfies DatabaseService)
