import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
  CapabilityError,
  type Database,
  GuardError,
  MySQLDialect,
  PostgresDialect,
  db,
  eq,
  param,
  pg,
  type Dialect
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("prepared query handles (spec §15.15)", () => {
  const FindUserByEmail = db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, param("email", Schema.String)))
    .prepare("FindUserByEmail")

  it("is a reusable handle that binds values per call", async () => {
    const adaDriver = new FakeDriver().enqueue({ rows: [{ id: "u1", name: "Ada" }] })
    const graceDriver = new FakeDriver().enqueue({ rows: [{ id: "u2", name: "Grace" }] })

    const a = await run(FindUserByEmail.one({ email: "ada@example.com" }), adaDriver)
    const g = await run(FindUserByEmail.one({ email: "grace@example.com" }), graceDriver)

    expect(a).toEqual({ id: "u1", name: "Ada" })
    expect(g).toEqual({ id: "u2", name: "Grace" })
    expect(adaDriver.calls[0]!.sql).toBe(graceDriver.calls[0]!.sql)
    expect(adaDriver.calls[0]!.params).toEqual(["ada@example.com"])
    expect(graceDriver.calls[0]!.params).toEqual(["grace@example.com"])
    expect(adaDriver.preparedNames[0]).toBe(graceDriver.preparedNames[0])
  })

  it("exposes shape metadata without executing", () => {
    expect(FindUserByEmail.name).toBe("FindUserByEmail")
    expect(FindUserByEmail.inspect()).toMatchObject({
      kind: "Select",
      tables: ["users"],
      params: ["email"],
      prepared: {
        name: "FindUserByEmail",
        structuralHash: expect.stringMatching(/^[0-9a-f]{8}$/),
        structuralGuard: "passed",
        capabilityBits: 0n
      }
    })
    expect(FindUserByEmail.toSql().sql).toBe(
      'SELECT "users"."id" AS "id", "users"."name" AS "name" FROM "users" WHERE "users"."email" = $1'
    )
  })

  it("prepares a returning mutation with run()/one() and its capabilities", async () => {
    const CreateUser = db
      .insert(users)
      .values({ email: param("email", Schema.String) })
      .returning({ id: users.id })
      .prepare("CreateUser")
    expect(CreateUser.requiredCapabilities()).toEqual(["insert.returning"])

    const driver = new FakeDriver().enqueue({ rows: [{ id: "new" }] })
    const row = await run(CreateUser.one({ email: "x@example.com" }), driver)
    expect(row).toEqual({ id: "new" })
    expect(driver.calls[0]!.sql).toContain("INSERT INTO")
    expect(driver.calls[0]!.params).toEqual(["x@example.com"])
  })

  it("compiles once per dialect inside the handle", async () => {
    let compileCount = 0
    const countingDialect: Dialect = {
      ...PostgresDialect,
      compileQuery: (ir) => {
        compileCount++
        return PostgresDialect.compileQuery(ir)
      }
    }
    const driver = new FakeDriver().enqueue(
      { rows: [{ id: "u1", name: "Ada" }] },
      { rows: [{ id: "u1", name: "Ada" }] }
    )

    // `.all()` stays on the base plan; `.one()`/`.maybeOne()` compile a separate
    // two-row cardinality-probe plan (P0.5/Finding 5), so keep this memoization
    // check on one shape.
    FindUserByEmail.toSql(countingDialect)
    FindUserByEmail.toSql(countingDialect)
    await Effect.runPromise(
      Effect.provide(
        FindUserByEmail.all({ email: "a@example.com" }),
        FakeDatabaseLayer(driver, { dialect: countingDialect })
      )
    )
    await Effect.runPromise(
      Effect.provide(
        FindUserByEmail.all({ email: "b@example.com" }),
        FakeDatabaseLayer(driver, { dialect: countingDialect })
      )
    )

    expect(compileCount).toBe(1)
    expect(FindUserByEmail.inspect().prepared.dialects).toContainEqual(
      expect.objectContaining({ dialect: "postgres", guard: "passed", cacheKey: expect.any(String) })
    )
  })

  it("rejects unsupported capabilities before calling the driver", async () => {
    const CreateUser = db
      .insert(users)
      .values({ email: param("email", Schema.String) })
      .returning({ id: users.id })
      .prepare("CreateUserMySQLGuard")
    const driver = new FakeDriver()

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(CreateUser.one({ email: "x@example.com" }), FakeDatabaseLayer(driver, { dialect: MySQLDialect }))
      )
    )
    expect(error).toBeInstanceOf(CapabilityError)
    expect(driver.calls).toEqual([])
    expect(CreateUser.inspect().prepared.dialects).toContainEqual(
      expect.objectContaining({ dialect: "mysql", guard: "failed" })
    )
  })

  it("precomputes structural guard failures without touching a driver", async () => {
    // A `returning` column from another table is a structural (table-scope)
    // guard failure that still constructs — empty inserts are now rejected at
    // construction (P0.6), so they cannot reach the prepared handle.
    const InvalidInsert = db
      .insert(users)
      .values({ email: param("email", Schema.String) })
      .returning({ id: posts.id })
      .prepare("InvalidInsert")
    const driver = new FakeDriver()

    expect(InvalidInsert.inspect().prepared.structuralGuard).toBe("failed")
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(InvalidInsert.one({ email: "a@example.com" }), FakeDatabaseLayer(driver)))
    )
    expect(error).toBeInstanceOf(GuardError)
    expect(driver.calls).toEqual([])
  })

  it("refuses to capture inline values in a static handle", () => {
    expect(() =>
      db.select({ id: users.id }).from(users).where(eq(users.email, "captured@example.com")).prepare("CapturedValue")
    ).toThrow(GuardError)
  })
})
