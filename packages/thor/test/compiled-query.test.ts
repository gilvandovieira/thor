import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect, Option, Schema } from "effect"
import {
  CapabilityError,
  CompileError,
  Database,
  MySQLDialect,
  PostgresDialect,
  db,
  eq,
  param,
  pg,
  type CompiledQuery,
  type Dialect
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver, dialect: Dialect = PostgresDialect) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver, { dialect })))

describe("compiled query API (v1 spec §8)", () => {
  const FindUserByEmail = db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, param("email", Schema.String)))
    .one()
    .compile()

  it("exposes stable shape metadata and its six-axis public type", () => {
    expect(FindUserByEmail.cacheKey).toMatch(/^postgres:[0-9a-f]{8}:[0-9a-f]{8}$/)
    expect(FindUserByEmail.dialect).toBe(PostgresDialect)
    expect(FindUserByEmail.cardinality).toBe("one")
    expect(FindUserByEmail.capabilities).toEqual(new Set())

    expectTypeOf(FindUserByEmail).toMatchTypeOf<CompiledQuery<
      { email: string },
      { id: string; email: string },
      unknown,
      Database,
      typeof PostgresDialect,
      "one"
    >>()
  })

  it("binds values per execution without changing SQL, cache identity, or prepared identity", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [{ id: "u1", email: "ada@example.com" }] },
      { rows: [{ id: "u2", email: "grace@example.com" }] }
    )

    const ada = await run(FindUserByEmail.execute({ email: "ada@example.com" }), driver)
    const grace = await run(FindUserByEmail.execute({ email: "grace@example.com" }), driver)

    expect(ada).toEqual({ id: "u1", email: "ada@example.com" })
    expect(grace).toEqual({ id: "u2", email: "grace@example.com" })
    expect(driver.calls.map((call) => call.params)).toEqual([
      ["ada@example.com"],
      ["grace@example.com"]
    ])
    expect(driver.calls[0]!.sql).toBe(driver.calls[1]!.sql)
    expect(driver.preparedNames).toEqual([FindUserByEmail.cacheKey, FindUserByEmail.cacheKey])
  })

  it("compiles once and reuses the retained statement on every execution", async () => {
    let compileCount = 0
    const dialect: Dialect = {
      ...PostgresDialect,
      compileQuery: (ir) => {
        compileCount++
        return PostgresDialect.compileQuery(ir)
      }
    }
    const compiled = db.select({ id: users.id }).from(users).one().compile(dialect)
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] }, { rows: [{ id: "u2" }] })

    await run(compiled.execute(), driver, dialect)
    await run(compiled.execute(), driver, dialect)

    expect(compileCount).toBe(1)
  })

  it("rejects a mismatched dialect profile before binding or calling the driver", async () => {
    const driver = new FakeDriver()
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(FindUserByEmail.execute({ email: "a@example.com" }), FakeDatabaseLayer(driver, {
        dialect: MySQLDialect
      })))
    )

    expect(error).toBeInstanceOf(CompileError)
    expect(driver.calls).toEqual([])
  })

  it("validates required capabilities when the handle is compiled", () => {
    const returning = db
      .insert(users)
      .values({ id: param("id", Schema.String), email: param("email", Schema.String) })
      .returning({ id: users.id })
      .one()

    expect(() => returning.compile(MySQLDialect)).toThrow(CapabilityError)

    const compiled = returning.compile(PostgresDialect)
    expect(compiled.capabilities).toEqual(new Set(["insert.returning"]))
  })

  it("supports all, maybeOne, and command cardinality handles", async () => {
    const all = db.select({ id: users.id }).from(users).all().compile()
    const maybeOne = db.select({ id: users.id }).from(users).maybeOne().compile()
    const command = db.delete(users).run().compile()

    expect(all.cardinality).toBe("all")
    expect(maybeOne.cardinality).toBe("maybeOne")
    expect(command.cardinality).toBe("run")

    await expect(run(all.execute(), new FakeDriver().enqueue({ rows: [{ id: "u1" }] }))).resolves.toEqual([{ id: "u1" }])
    await expect(run(maybeOne.execute(), new FakeDriver().enqueue({ rows: [] }))).resolves.toEqual(Option.none())
    await expect(run(command.execute(), new FakeDriver().enqueue({ rowCount: 2 }))).resolves.toEqual({ rowCount: 2 })
  })

  it("rejects inline values because compiled handles represent shapes only", () => {
    const terminal = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "captured@example.com"))
      .one()

    expect(() => terminal.compile()).toThrow(/cannot capture value/i)
  })
})
