import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import { CapabilityError, and, db, eq, ilike, param, pg, sql, unsafeSql } from "@gilvandovieira/thor"
import { compileOperation, makeMigrator, tableToCreateOp, type MigrationPlan } from "@gilvandovieira/thor/migrate"
import { PostgresDialect, makePostgresJsDriver } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import { FakeDatabaseLayer, FakeDriver, expectSql } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})

describe("query dialect independence", () => {
  it("scopes postgres.js prepared admission to the physical client", () => {
    const pending = Object.assign(Promise.resolve(Object.assign([], { count: 0 })), {
      simple: () => Promise.resolve(Object.assign([], { count: 0 }))
    })
    const client = { unsafe: () => pending }

    expect(makePostgresJsDriver(client).preparedScope).toBe(client)
  })

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

  it("quotes raw-expression column interpolations in the active dialect", () => {
    const query = db.select({ id: users.id }).from(users).where(sql`${users.email} IS NOT NULL`)

    expect(expectSql(query, PostgresDialect).sql).toContain('"users"."email" IS NOT NULL')
    expect(expectSql(query, SQLiteDialect).sql).toContain('"users"."email" IS NOT NULL')
    expect(expectSql(query, MySQLDialect).sql).toContain("`users`.`email` IS NOT NULL")
  })

  it("rejects ordinary raw interpolation and makes dynamic text visibly unsafe", () => {
    expect(() => sql`${"1; drop table users" as never}`).toThrow(
      "Raw SQL interpolation accepts only param(...), columns, or unsafeSql(...)"
    )

    const query = db
      .select({ id: users.id })
      .from(users)
      .where(sql`${unsafeSql("TRUE")}`)
    expect(expectSql(query, PostgresDialect).sql).toContain("WHERE TRUE")
  })

  it("rejects objects forged to resemble unsafeSql nodes", () => {
    const forged = { _tag: "UnsafeSql", sql: "TRUE; drop table users; --" }
    expect(() => sql`${forged as never}`).toThrow(
      "Raw SQL interpolation accepts only param(...), columns, or unsafeSql(...)"
    )
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
    expect(compileOperation(operation, PostgresDialect)).toContain('"created_at" timestamptz not null default now()')
    expect(compileOperation(operation, SQLiteDialect)).toContain('"id" text not null default (lower(')
    expect(compileOperation(operation, SQLiteDialect)).toContain('"created_at" text not null default CURRENT_TIMESTAMP')
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

  it("rejects SQLite ADD COLUMN shapes that require a table rebuild", () => {
    const add = (column: Record<string, unknown>) => () =>
      compileOperation(
        { _tag: "AddColumn", table: "users", column, destructive: false, reversible: true, capabilities: [] } as never,
        SQLiteDialect
      )
    expect(add({ name: "email", type: "text", nullable: true, unique: true })).toThrow(/table rebuild is required/)
    expect(
      add({ name: "slug", type: "text", nullable: true, generated: { expression: "lower(name)", stored: true } })
    ).toThrow(/table rebuild is required/)
    expect(add({ name: "created_at", type: "timestamptz", nullable: false, default: { kind: "now" } })).toThrow(
      /table rebuild is required/
    )
    expect(add({ name: "level", type: "integer", nullable: false })).toThrow(/table rebuild is required/)

    // A plain nullable column and a NOT NULL column with a constant default remain valid.
    expect(add({ name: "nickname", type: "text", nullable: true })()).toBe(
      'alter table "users" add column "nickname" text;'
    )
    expect(add({ name: "active", type: "boolean", nullable: false, default: { kind: "value", value: true } })()).toBe(
      'alter table "users" add column "active" integer not null default 1;'
    )
  })

  it("surfaces an unsupported SQLite ADD COLUMN as a tagged MigrationError through the migrator", async () => {
    const driver = new FakeDriver()
    const plan: MigrationPlan = {
      id: "20260709_add_unique",
      name: "add_unique",
      operations: [
        {
          _tag: "AddColumn",
          table: "users",
          column: { name: "email", type: "text", nullable: true, unique: true },
          destructive: false,
          reversible: true,
          capabilities: []
        }
      ]
    }
    const program = Effect.flatMap(makeMigrator(), (migrator) => migrator.apply(plan))
    const exit = await Effect.runPromiseExit(
      Effect.provide(program, FakeDatabaseLayer(driver, { dialect: SQLiteDialect }))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("MigrationError")
    expect(JSON.stringify(exit)).toContain("table rebuild is required")
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
      "begin immediate",
      expect.stringContaining('create table if not exists "_thor_migrations"'),
      expect.stringContaining("select id, name, checksum"),
      expect.stringContaining('create table "users"'),
      expect.stringContaining('insert into "_thor_migrations"'),
      "commit"
    ])
    expect(driver.calls[4]?.sql).toContain("values (?, ?, ?, ?, ?)")
    expect(driver.calls.some((call) => call.sql.includes("pg_advisory"))).toBe(false)
  })

  it("uses a MySQL named lock without wrapping DDL in a transaction", async () => {
    // The MySQL journal probe (checksum-column width, len already 255 → no
    // upgrade) runs once after ensureJournal DDL.
    const driver = new FakeDriver().enqueue(
      { rows: [{ acquired: 1 }] },
      {},
      { rows: [{ len: 255 }] },
      { rows: [] },
      {},
      {},
      { rows: [{ released: 1 }] }
    )
    const plan: MigrationPlan = {
      id: "20260709_create_users",
      name: "create_users",
      operations: [tableToCreateOp(users)]
    }
    const program = Effect.flatMap(makeMigrator(), (migrator) => migrator.apply(plan))

    await Effect.runPromise(Effect.provide(program, FakeDatabaseLayer(driver, { dialect: MySQLDialect })))

    expect(driver.calls.map((call) => call.sql)).toEqual([
      "select get_lock(?, 30) as acquired",
      expect.stringContaining("create table if not exists `_thor_migrations`"),
      expect.stringContaining("information_schema.columns"),
      expect.stringContaining("select id, name, checksum"),
      expect.stringContaining("create table `users`"),
      expect.stringContaining("insert into `_thor_migrations`"),
      "select release_lock(?) as released"
    ])
    expect(driver.calls.some((call) => ["begin", "commit", "rollback"].includes(call.sql))).toBe(false)
    expect(driver.calls[0]?.params).toEqual([expect.stringMatching(/^thor:/)])
  })

  it("stops a MySQL migration when the named lock times out", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ acquired: 0 }] })
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
    expect(driver.calls).toHaveLength(1)
  })
})
