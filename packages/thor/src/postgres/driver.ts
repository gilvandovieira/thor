/**
 * Postgres driver adapter (spec Milestone 5).
 *
 * Adapts a minimal node-postgres-style client to Thor's `Driver` contract
 * without taking a hard dependency on the `pg` package — pass any client that
 * can run `(sql, params) => { rows }`. Native failures are mapped to
 * `ConstraintError` / `DriverError`.
 *
 * @module postgres/driver
 */
import { Effect, Layer } from "effect"
import type { CommandResult, Driver, RawRow } from "../execution/driver.js"
import { Database, type DatabaseService } from "../execution/database.js"
import { PostgresDialect } from "./dialect.js"
import { mapDriverError } from "./errors.js"
import { assertRuntimeCapabilities, defineRuntimeRequirements } from "../capabilities/runtime.js"

type PgResult = { readonly rows: ReadonlyArray<RawRow>; readonly rowCount: number | null }

/** Runtime-neutral contract for the structural node-postgres-compatible adapter. */
export const PostgresDriverRuntime = defineRuntimeRequirements("postgres/node-postgres-compatible", [])

/** A node-postgres query config (the object form, used for named prepared statements). */
export interface PgQueryConfig {
  readonly text: string
  readonly values?: ReadonlyArray<unknown>
  readonly name?: string
}

/** The slice of a pg client Thor needs. Both call forms exist on `pg.Client`. */
export interface PgClient {
  readonly query: {
    (sql: string, params?: ReadonlyArray<unknown>): Promise<PgResult>
    (config: PgQueryConfig): Promise<PgResult>
  }
}

/**
 * Choose how to invoke node-postgres:
 *   - no params → simple protocol (allows multi-statement DDL);
 *   - params + prepared name → named prepared statement (parsed once, reused);
 *   - params, no name → unnamed extended protocol.
 *
 * node-postgres caches prepared statements per connection by `name` and ignores
 * the `text` on reuse, so a 32-bit `cacheKey` collision (two different SQL texts
 * hashing to one name) would silently run the wrong statement. `seen` guards
 * against that: on a name/text mismatch we fall back to an unnamed query.
 *
 * @param client - Connected node-postgres-compatible client.
 * @returns A collision-aware query invocation function.
 */
const makeCall = (client: PgClient) => {
  const seen = new Map<string, string>()
  return (sql: string, params: ReadonlyArray<unknown>, name?: string): Promise<PgResult> => {
    if (params.length === 0) return client.query(sql)
    if (name) {
      const priorText = seen.get(name)
      if (priorText === undefined) seen.set(name, sql)
      if (priorText === undefined || priorText === sql) {
        return client.query({ text: sql, values: params, name })
      }
    }
    return client.query(sql, params)
  }
}

/**
 * Adapts a node-postgres-compatible client to Thor's driver contract.
 *
 * @param client - Connected client or structurally compatible query object.
 * @returns A Thor driver with prepared-statement collision protection.
 */
export const makePostgresDriver = (client: PgClient): Driver => {
  assertRuntimeCapabilities(PostgresDriverRuntime)
  const call = makeCall(client)
  return {
    runtime: PostgresDriverRuntime,
    query: (sql, params, name) =>
      Effect.tryPromise({ try: () => call(sql, params, name), catch: mapDriverError }).pipe(Effect.map((r) => r.rows)),
    execute: (sql, params, name) =>
      Effect.tryPromise({ try: () => call(sql, params, name), catch: mapDriverError }).pipe(
        Effect.map((r): CommandResult => ({ rowCount: r.rowCount ?? 0 }))
      ),
    executeScript: (sql) =>
      Effect.tryPromise({ try: () => client.query(sql), catch: mapDriverError }).pipe(
        Effect.map((r): CommandResult => ({ rowCount: r.rowCount ?? 0 }))
      )
  }
}

/**
 * Creates a PostgreSQL `Database` layer.
 *
 * @param client - Connected PostgreSQL client. Use a dedicated connection for migrations.
 * @param options - Emulation and prepared-statement settings.
 * @returns An Effect layer providing `Database`.
 */
export const PostgresLayer = (
  client: PgClient,
  options: { readonly allowEmulation?: boolean; readonly preparedStatements?: boolean } = {}
): Layer.Layer<Database> =>
  Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: makePostgresDriver(client),
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  } satisfies DatabaseService)
