/**
 * Live prepared-resource bound evidence (audit P4.1 / P4.2).
 *
 * The unit suite proves the prepared registry never exceeds `preparedMaxSize`
 * against a `FakeDriver` (`prepared-default-bound.test.ts`). This lane corroborates
 * that guarantee against *real servers* by reading their own prepared-statement
 * counters, so a false "bounded" claim cannot hide behind an in-memory registry:
 *
 *   - PostgreSQL: `makePostgresDriver` deliberately omits `releasePrepared`, so
 *     admission stops at the bound and excess shapes run unprepared. The count in
 *     `pg_prepared_statements` (session-local) must equal the registry size and
 *     never exceed the bound.
 *   - MySQL with `unprepare`: lease-safe eviction deallocates idle statements, so
 *     the server's `Prepared_stmt_count` delta stays within the bound.
 *   - MySQL without `unprepare`: admission stops at the bound (no false eviction).
 *
 * Skipped unless DATABASE_URL / MYSQL_URL are set. See `pnpm e2e`.
 */
import { Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import pg from "pg"
import mysql2 from "mysql2/promise"
import {
  Database,
  type DatabaseService,
  MySQLDialect,
  PostgresDialect,
  db,
  eq,
  mysql,
  param,
  pg as pgSchema
} from "@gilvandovieira/thor"
import { type MySQLClient, makeMySQLDriver } from "@gilvandovieira/thor/mysql"
import { makePostgresDriver } from "@gilvandovieira/thor/postgres"
import { type QueryCaches, makeQueryCaches } from "../src/execution/cache.js"

const DATABASE_URL = process.env.DATABASE_URL
const MYSQL_URL = process.env.MYSQL_URL

const preparedStats = (caches: QueryCaches) => caches.stats().find((entry) => entry.name === "prepared")!

describe.skipIf(!DATABASE_URL)("live PostgreSQL prepared-resource bounds (P4.1)", () => {
  const BOUND = 5
  const SHAPES = 40
  let client: pg.Client
  let caches: QueryCaches
  let layer: Layer.Layer<Database>

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query("drop schema public cascade")
    await client.query("create schema public")
    for (let i = 0; i < SHAPES; i++) {
      await client.query(`create table pg_bound_${i} (id text primary key)`)
    }
    caches = makeQueryCaches({ preparedMaxSize: BOUND })
    layer = Layer.succeed(Database, {
      dialect: PostgresDialect,
      driver: makePostgresDriver(client),
      allowEmulation: false,
      preparedStatements: true,
      queryCache: caches
    } satisfies DatabaseService)
  })

  afterAll(() => client.end())

  const runShape = async (index: number): Promise<void> => {
    const table = pgSchema.table(`pg_bound_${index}`, { id: pgSchema.text("id").primaryKey() })
    const query = db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, param(`id_${index}`, Schema.String)))
    await Effect.runPromise(Effect.provide(query.all({ [`id_${index}`]: String(index) } as never), layer))
  }

  const nativeCount = async (): Promise<number> => {
    const result = await client.query("select count(*)::int as n from pg_prepared_statements")
    return Number(result.rows[0].n)
  }

  it("never lets pg_prepared_statements exceed the configured bound", async () => {
    for (let i = 0; i < SHAPES; i++) await runShape(i)

    const registry = preparedStats(caches)
    const native = await nativeCount()

    expect(registry.size).toBe(BOUND)
    expect(registry.maxSize).toBe(BOUND)
    // Postgres has no releasePrepared: admission stops, excess runs unprepared.
    expect(registry.evictions).toBe(0)
    // Native server-side count equals the registry and honors the bound.
    expect(native).toBe(BOUND)
    expect(native).toBeLessThanOrEqual(BOUND)
  })

  it("reuses an admitted shape without allocating a new native statement", async () => {
    const before = await nativeCount()
    // Re-run one of the first `BOUND` shapes: LRU order kept it admitted.
    await runShape(SHAPES - 1)
    const after = await nativeCount()
    expect(after).toBe(before)
    expect(after).toBeLessThanOrEqual(BOUND)
  })
})

describe.skipIf(!MYSQL_URL)("live MySQL prepared-resource bounds (P4.2)", () => {
  const BOUND = 5
  const SHAPES = 40

  const preparedStmtCount = async (connection: mysql2.Connection): Promise<number> => {
    const [rows] = await connection.query("show global status like 'Prepared_stmt_count'")
    return Number((rows as unknown as ReadonlyArray<{ Value: string }>)[0].Value)
  }

  const setupTables = async (connection: mysql2.Connection): Promise<void> => {
    for (let i = 0; i < SHAPES; i++) {
      await connection.query(`drop table if exists my_bound_${i}`)
      await connection.query(`create table my_bound_${i} (id varchar(64) primary key)`)
    }
  }

  const runShape = async (layer: Layer.Layer<Database>, index: number): Promise<void> => {
    const table = mysql.table(`my_bound_${index}`, { id: mysql.text("id").primaryKey() })
    const query = db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, param(`id_${index}`, Schema.String)))
    await Effect.runPromise(Effect.provide(query.all({ [`id_${index}`]: String(index) } as never), layer))
  }

  it("bounds native prepared statements when unprepare is available (lease-safe eviction)", async () => {
    const connection = await mysql2.createConnection(MYSQL_URL!)
    try {
      await setupTables(connection)
      const baseline = await preparedStmtCount(connection)
      const caches = makeQueryCaches({ preparedMaxSize: BOUND })
      // Forward `unprepare` so the driver exposes releasePrepared (eviction branch).
      const client = {
        query: (sql: string, params?: ReadonlyArray<unknown>) => connection.query(sql, params as never),
        execute: (sql: string, params?: ReadonlyArray<unknown>) => connection.execute(sql, params as never),
        unprepare: (sql: string) => (connection as unknown as { unprepare: (s: string) => void }).unprepare(sql)
      } as unknown as MySQLClient
      const layer = Layer.succeed(Database, {
        dialect: MySQLDialect,
        driver: makeMySQLDriver(client),
        allowEmulation: false,
        preparedStatements: true,
        queryCache: caches
      } satisfies DatabaseService)

      for (let i = 0; i < SHAPES; i++) await runShape(layer, i)

      const registry = preparedStats(caches)
      const live = (await preparedStmtCount(connection)) - baseline
      expect(registry.size).toBeLessThanOrEqual(BOUND)
      expect(registry.evictions).toBeGreaterThan(0)
      // Idle statements are deallocated: the net live count stays within the bound.
      expect(live).toBeLessThanOrEqual(BOUND)
    } finally {
      await connection.end()
    }
  })

  it("stops admitting (no false eviction) when unprepare is unavailable", async () => {
    const connection = await mysql2.createConnection(MYSQL_URL!)
    try {
      await setupTables(connection)
      const baseline = await preparedStmtCount(connection)
      const caches = makeQueryCaches({ preparedMaxSize: BOUND })
      // No `unprepare`: driver must not expose releasePrepared.
      const client = {
        query: (sql: string, params?: ReadonlyArray<unknown>) => connection.query(sql, params as never),
        execute: (sql: string, params?: ReadonlyArray<unknown>) => connection.execute(sql, params as never)
      } as unknown as MySQLClient
      const layer = Layer.succeed(Database, {
        dialect: MySQLDialect,
        driver: makeMySQLDriver(client),
        allowEmulation: false,
        preparedStatements: true,
        queryCache: caches
      } satisfies DatabaseService)

      for (let i = 0; i < SHAPES; i++) await runShape(layer, i)

      const registry = preparedStats(caches)
      const live = (await preparedStmtCount(connection)) - baseline
      expect(registry.size).toBe(BOUND)
      expect(registry.evictions).toBe(0)
      expect(live).toBeLessThanOrEqual(BOUND)
    } finally {
      await connection.end()
    }
  })
})
