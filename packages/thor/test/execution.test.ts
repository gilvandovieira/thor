import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect, Option, Schema } from "effect"
import {
  type Database,
  DecodeError,
  DriverError,
  GuardError,
  NotFoundError,
  ParameterError,
  TooManyRowsError,
  avg,
  count,
  db,
  eq,
  param,
  pg,
  sum
} from "@gilvandovieira/thor"
import { FakeDriver, FakeDatabaseLayer } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  age: pg.integer("age").nullable(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow(),
  visits: pg.bigint("visits").nullable()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").notNull(),
  title: pg.text("title").notNull()
})

const provideDatabase = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.provide(effect, FakeDatabaseLayer(driver))

const runSuccess = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(provideDatabase(effect, driver))

const runFailure = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.flip(provideDatabase(effect, driver)))

describe("fake driver execution (spec §14.9)", () => {
  it("compiles SQL, binds named params, and decodes every selected field", async () => {
    const driver = new FakeDriver().enqueue({
      rows: [{ id: "u1", email: "a@example.com", createdAt: "2026-01-01T00:00:00Z" }]
    })

    const rows = await runSuccess(
      db
        .select({ id: users.id, email: users.email, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.email, param("email", Schema.String)))
        .all({ email: "a@example.com" }),
      driver
    )

    expect(rows).toStrictEqual([{ id: "u1", email: "a@example.com", createdAt: new Date("2026-01-01T00:00:00.000Z") }])
    expect(driver.calls).toStrictEqual([
      {
        sql: 'SELECT "users"."id" AS "id", "users"."email" AS "email", "users"."created_at" AS "createdAt" FROM "users" WHERE "users"."email" = $1',
        params: ["a@example.com"]
      }
    ])
  })

  it("validates and encodes named parameters before calling the driver", async () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.age, param("age", Schema.NumberFromString)))
    const driver = new FakeDriver().enqueue({ rows: [] })

    await runSuccess(query.all({ age: 42 }), driver)
    expect(driver.calls[0]?.params).toEqual(["42"])

    for (const [args, reason] of [
      [{}, "missing"],
      [{ age: "42" }, "invalid"],
      [{ age: 42, other: true }, "extra"]
    ] as const) {
      const rejectedDriver = new FakeDriver()
      const error = await runFailure(
        (query.all as (args: unknown) => ReturnType<typeof query.all>)(args),
        rejectedDriver
      )
      expect(error).toBeInstanceOf(ParameterError)
      expect(error).toMatchObject({ _tag: "ParameterError", reason })
      expect(rejectedDriver.calls).toEqual([])
    }
  })

  it("rejects duplicate and conflicting named parameter declarations", async () => {
    const duplicates = db
      .select({ id: users.id })
      .from(users)
      .where(
        // Distinct declarations with the same name are ambiguous even when their schemas match.
        {
          _tag: "Logical",
          op: "and",
          operands: [eq(users.email, param("value", Schema.String)), eq(users.email, param("value", Schema.String))]
        }
      )
    const conflicts = db
      .select({ id: users.id })
      .from(users)
      .where({
        _tag: "Logical",
        op: "and",
        operands: [eq(users.email, param("value", Schema.String)), eq(users.age, param("value", Schema.Number))]
      })

    for (const [query, reason] of [
      [duplicates, "duplicate"],
      [conflicts, "conflict"]
    ] as const) {
      const driver = new FakeDriver()
      const error = await runFailure(
        (query.all as (args: unknown) => ReturnType<typeof query.all>)({ value: "x" }),
        driver
      )
      expect(error).toMatchObject({ _tag: "ParameterError", reason })
      expect(driver.calls).toEqual([])
    }
  })

  it("makes outer-joined columns nullable in the type and decoder plan", async () => {
    const left = db
      .select({ email: users.email, title: posts.title })
      .from(users)
      .leftJoin(posts, eq(users.id, posts.userId))
    type LeftRows = typeof left extends { all: (...args: never[]) => Effect.Effect<infer Rows, any, any> }
      ? Rows
      : never
    expectTypeOf<LeftRows>().toEqualTypeOf<ReadonlyArray<{ email: string; title: string | null }>>()

    const driver = new FakeDriver().enqueue({ rows: [{ email: "a@example.com", title: null }] })
    await expect(runSuccess(left.all(), driver)).resolves.toEqual([{ email: "a@example.com", title: null }])
  })

  it("makes the preserved-left side of a right join nullable in the type and decoder plan", async () => {
    const right = db
      .select({ email: users.email, title: posts.title })
      .from(users)
      .rightJoin(posts, eq(users.id, posts.userId))
    type RightRows = typeof right extends { all: (...args: never[]) => Effect.Effect<infer Rows, any, any> }
      ? Rows
      : never
    expectTypeOf<RightRows>().toEqualTypeOf<ReadonlyArray<{ email: string | null; title: string }>>()

    const driver = new FakeDriver().enqueue({ rows: [{ email: null, title: "hello" }] })
    await expect(runSuccess(right.all(), driver)).resolves.toEqual([{ email: null, title: "hello" }])
  })

  it("decodes PostgreSQL-style bigint and numeric aggregate strings in safe mode", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [{ total: "2", sumAge: "60", averageAge: "30.5" }] },
      { rows: [{ visits: "9223372036854775807" }] }
    )
    const rows = await runSuccess(
      db
        .select({ total: count(), sumAge: sum(users.age), averageAge: avg(users.age) })
        .from(users)
        .all(),
      driver
    )
    expect(rows).toEqual([{ total: 2, sumAge: 60, averageAge: 30.5 }])
    await expect(runSuccess(db.select({ visits: users.visits }).from(users).all(), driver)).resolves.toEqual([
      { visits: 9223372036854775807n }
    ])

    const tooLarge = new FakeDriver().enqueue({ rows: [{ total: "9007199254740992" }] })
    const error = await runFailure(db.select({ total: count() }).from(users).all(), tooLarge)
    expect(error).toMatchObject({ _tag: "DecodeError", message: expect.stringContaining("safe integer") })
  })

  it("returns the selected row from one()", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })

    await expect(runSuccess(db.select({ id: users.id }).from(users).one(), driver)).resolves.toStrictEqual({ id: "u1" })
  })

  it("returns a tagged NotFoundError when one() receives zero rows", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })

    const error = await runFailure(db.select({ id: users.id }).from(users).one(), driver)

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({
      _tag: "NotFoundError",
      message: "select.one: expected one row, found none"
    })
  })

  it("returns a tagged TooManyRowsError with the observed count", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "a" }, { id: "b" }] })

    const error = await runFailure(db.select({ id: users.id }).from(users).one(), driver)

    expect(error).toBeInstanceOf(TooManyRowsError)
    expect(error).toMatchObject({
      _tag: "TooManyRowsError",
      count: 2,
      message: "select.one: expected one row, found 2"
    })
  })

  it("distinguishes empty and populated maybeOne() results", async () => {
    const emptyDriver = new FakeDriver().enqueue({ rows: [] })
    const rowDriver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })

    await expect(runSuccess(db.select({ id: users.id }).from(users).maybeOne(), emptyDriver)).resolves.toStrictEqual(
      Option.none()
    )
    await expect(runSuccess(db.select({ id: users.id }).from(users).maybeOne(), rowDriver)).resolves.toStrictEqual(
      Option.some({ id: "u1" })
    )
  })

  it("rejects multiple rows from maybeOne()", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] })

    const error = await runFailure(db.select({ id: users.id }).from(users).maybeOne(), driver)

    expect(error).toMatchObject({ _tag: "TooManyRowsError", count: 3 })
  })

  it("decodes rows returned by insert().returning()", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "new-id", createdAt: "2026-07-09T12:00:00Z" }] })

    const row = await runSuccess(
      db.insert(users).values({ email: "x@example.com" }).returning({ id: users.id, createdAt: users.createdAt }).one(),
      driver
    )

    expect(row).toStrictEqual({ id: "new-id", createdAt: new Date("2026-07-09T12:00:00.000Z") })
    expect(driver.calls[0]).toStrictEqual({
      sql: 'INSERT INTO "users" ("email") VALUES ($1) RETURNING "users"."id" AS "id", "users"."created_at" AS "createdAt"',
      params: ["x@example.com"]
    })
  })

  it("refines DML RETURNING cardinality after execution without a non-portable limit", async () => {
    const none = new FakeDriver().enqueue({ rows: [] })
    const many = new FakeDriver().enqueue({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] })

    await expect(
      runSuccess(db.update(users).set({ age: 1 }).returning({ id: users.id }).maybeOne(), none)
    ).resolves.toStrictEqual(Option.none())
    const error = await runFailure(db.delete(users).returning({ id: users.id }).one(), many)

    expect(error).toMatchObject({ _tag: "TooManyRowsError", count: 3 })
    expect(none.calls[0]?.sql).not.toMatch(/LIMIT/)
    expect(many.calls[0]?.sql).not.toMatch(/LIMIT/)
  })

  it("returns the command row count", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 3 })

    await expect(runSuccess(db.delete(users).run(), driver)).resolves.toStrictEqual({ rowCount: 3 })
    expect(driver.calls).toStrictEqual([{ sql: 'DELETE FROM "users"', params: [] }])
  })

  it("surfaces field decoding failures as DecodeError", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ createdAt: "not-a-timestamp" }] })

    const error = await runFailure(db.select({ createdAt: users.createdAt }).from(users).all(), driver)

    expect(error).toBeInstanceOf(DecodeError)
    expect(error).toMatchObject({
      _tag: "DecodeError",
      message: expect.stringContaining('Failed to decode field "createdAt"')
    })
  })

  it("preserves driver failures", async () => {
    const failure = new DriverError({ message: "connection lost" })
    const driver = new FakeDriver().enqueue({ error: failure })

    const error = await runFailure(db.select({ id: users.id }).from(users).all(), driver)

    expect(error).toBe(failure)
  })

  it("runs guards before calling the driver", async () => {
    const driver = new FakeDriver()
    const outOfScope = db.select({ id: users.id }).from(users).where(eq(posts.id, users.id))

    const error = await runFailure(outOfScope.all(), driver)

    expect(error).toBeInstanceOf(GuardError)
    expect(error).toMatchObject({ _tag: "GuardError", guard: "table-scope" })
    expect(driver.calls).toEqual([])
  })
})
