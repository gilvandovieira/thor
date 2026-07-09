import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { CapabilityError, and, db, eq, ilike, param, pg, sql } from "@gilvandovieira/thor"
import { compileOperation, makeMigrator, tableToCreateOp, type MigrationPlan } from "@gilvandovieira/thor/migrate"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import { FakeDatabaseLayer, FakeDriver, expectSql } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})

describe("query dialect independence", () => {
  it("dispatches placeholder and comparison syntax through the selected dialect", () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(ilike(users.email, param("email", Schema.String)))

    expect(expectSql(query, PostgresDialect)).toMatchObject({
      sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE "users"."email" ILIKE $1',
      params: [{ name: "email" }],
      cacheKey: expect.stringMatching(/^postgres:/)
    })
    expect(expectSql(query, SQLiteDialect)).toMatchObject({
      sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE "users"."email" LIKE ? COLLATE NOCASE',
      params: [{ name: "email" }],
      cacheKey: expect.stringMatching(/^sqlite:/)
    })
    expect(expectSql(query, MySQLDialect)).toMatchObject({
      sql: "SELECT `users`.`id` AS `id` FROM `users` WHERE LOWER(`users`.`email`) LIKE LOWER(?)",
      params: [{ name: "email" }],
      cacheKey: expect.stringMatching(/^mysql:/)
    })
  })

  it("renumbers raw-expression parameters in the active dialect", () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, "a@example.com"), sql`${param("minimum", Schema.Number)} > 0`))

    expect(expectSql(query, PostgresDialect)).toMatchObject({
      sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = $1 AND $2 > 0)',
      params: [expect.objectContaining({ value: "a@example.com" }), { name: "minimum" }]
    })
    expect(expectSql(query, SQLiteDialect)).toMatchObject({
      sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = ? AND ? > 0)',
      params: [expect.objectContaining({ value: "a@example.com" }), { name: "minimum" }]
    })
  })

  it("uses the Database service dialect during execution", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })
    const effect = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
      .all({ email: "a@example.com" })

    await Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver, { dialect: SQLiteDialect })))

    expect(driver.calls).toStrictEqual([
      {
        sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE "users"."email" = ?',
        params: ["a@example.com"]
      }
    ])
    expect(driver.preparedNames[0]).toMatch(/^sqlite:/)
  })

  it("rejects MySQL returning queries before calling the driver", async () => {
    const driver = new FakeDriver()
    const query = db.insert(users).values({ email: "a@example.com" }).returning({ id: users.id }).one()

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(query, FakeDatabaseLayer(driver, { dialect: MySQLDialect })))
    )

    expect(error).toBeInstanceOf(CapabilityError)
    expect(error).toMatchObject({ capability: "insert.returning", dialect: "mysql" })
    expect(driver.calls).toEqual([])
  })
})

describe("migration dialect independence", () => {
  it("compiles logical column definitions for each backend", () => {
    const operation = tableToCreateOp(users)

    expect(compileOperation(operation, PostgresDialect)).toContain('"id" uuid not null default gen_random_uuid()')
    expect(compileOperation(operation, PostgresDialect)).toContain(
      '"created_at" timestamptz not null default now()'
    )
    expect(compileOperation(operation, SQLiteDialect)).toContain('"id" text not null default (lower(')
    expect(compileOperation(operation, SQLiteDialect)).toContain(
      '"created_at" text not null default CURRENT_TIMESTAMP'
    )
    expect(compileOperation(operation, MySQLDialect)).toContain("`id` char(36) not null default (uuid())")
    expect(compileOperation(operation, MySQLDialect)).toContain(
      "`created_at` datetime(3) not null default CURRENT_TIMESTAMP(3)"
    )
  })

  it("rejects SQLite ALTER operations that require a table rebuild", () => {
    expect(() =>
      compileOperation(
        {
          _tag: "SetNotNull",
          table: "users",
          column: "email",
          destructive: false,
          reversible: true,
          capabilities: []
        },
        SQLiteDialect
      )
    ).toThrow('SQLite migration operation "SetNotNull" requires a table rebuild')
  })

  it("uses SQLite journal, transaction, and DDL SQL in the live migrator", async () => {
    const driver = new FakeDriver().enqueue({}, {}, {}, {}, {})
    const plan: MigrationPlan = {
      id: "20260709_create_users",
      name: "create_users",
      operations: [tableToCreateOp(users)]
    }
    const program = Effect.flatMap(makeMigrator(), (migrator) => migrator.apply(plan))

    await Effect.runPromise(Effect.provide(program, FakeDatabaseLayer(driver, { dialect: SQLiteDialect })))

    expect(driver.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining('create table if not exists "_thor_migrations"'),
      "begin immediate",
      expect.stringContaining('create table "users"'),
      expect.stringContaining('insert into "_thor_migrations"'),
      "commit"
    ])
    expect(driver.calls[3]?.sql).toContain("values (?, ?, ?, ?, ?)")
    expect(driver.calls.some((call) => call.sql.includes("pg_advisory"))).toBe(false)
  })

  it("uses a MySQL named lock without wrapping DDL in a transaction", async () => {
    const driver = new FakeDriver().enqueue({}, { rows: [{ acquired: 1 }] }, {}, {}, {})
    const plan: MigrationPlan = {
      id: "20260709_create_users",
      name: "create_users",
      operations: [tableToCreateOp(users)]
    }
    const program = Effect.flatMap(makeMigrator(), (migrator) => migrator.apply(plan))

    await Effect.runPromise(Effect.provide(program, FakeDatabaseLayer(driver, { dialect: MySQLDialect })))

    expect(driver.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("create table if not exists `_thor_migrations`"),
      "select get_lock(?, 30) as acquired",
      expect.stringContaining("create table `users`"),
      expect.stringContaining("insert into `_thor_migrations`"),
      "select release_lock(?)"
    ])
    expect(driver.calls.some((call) => ["begin", "commit", "rollback"].includes(call.sql))).toBe(false)
    expect(driver.calls[1]?.params).toEqual([expect.stringMatching(/^thor:/)])
  })

  it("stops a MySQL migration when the named lock times out", async () => {
    const driver = new FakeDriver().enqueue({}, { rows: [{ acquired: 0 }] })
    const plan: MigrationPlan = {
      id: "20260709_create_users",
      name: "create_users",
      operations: [tableToCreateOp(users)]
    }
    const program = Effect.flatMap(makeMigrator(), (migrator) => migrator.apply(plan))

    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(program, FakeDatabaseLayer(driver, { dialect: MySQLDialect })))
    )

    expect(error).toMatchObject({
      _tag: "MigrationError",
      message: "Timed out acquiring the MySQL migration lock"
    })
    expect(driver.calls).toHaveLength(2)
  })
})
