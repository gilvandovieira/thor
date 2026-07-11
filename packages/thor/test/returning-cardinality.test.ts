import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type Database, TooManyRowsError, db, param, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("returning_users", {
  id: pg.text("id").primaryKey(),
  email: pg.text("email").notNull()
})

const rows = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index) }))
const runFailure = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.flip(Effect.provide(effect, FakeDatabaseLayer(driver))))

describe("DML RETURNING cardinality probes", () => {
  it.each([
    ["insert", () => db.insert(users).values({ id: "new", email: "a@example.com" }).returning({ id: users.id }).one()],
    ["update", () => db.update(users).set({ email: "changed@example.com" }).returning({ id: users.id }).one()],
    ["delete", () => db.delete(users).returning({ id: users.id }).one()]
  ] as const)("%s.one() observes at most two returned rows", async (_name, terminal) => {
    const driver = new FakeDriver().enqueue({ rows })
    const error = await runFailure(terminal(), driver)

    expect(error).toBeInstanceOf(TooManyRowsError)
    expect((error as TooManyRowsError).count).toBe(2)
  })

  it("maybeOne() uses the same bounded probe semantics", async () => {
    const driver = new FakeDriver().enqueue({ rows })
    const error = await runFailure(
      db.update(users).set({ email: "changed@example.com" }).returning({ id: users.id }).maybeOne(),
      driver
    )

    expect(Option.isOption(error)).toBe(false)
    expect(error).toMatchObject({ _tag: "TooManyRowsError", count: 2 })
  })

  it.each(["direct", "compiled", "prepared"] as const)("%s mutation handles use the bounded probe", async (mode) => {
    const returning = db
      .insert(users)
      .values({ id: param("id", Schema.String), email: param("email", Schema.String) })
      .returning({ id: users.id })
    const values = { id: mode, email: `${mode}@example.com` }
    const execution =
      mode === "direct"
        ? returning.one(values)
        : mode === "compiled"
          ? returning.one().compile().execute(values)
          : returning.prepare("returning-cardinality").one(values)

    const error = await runFailure(execution, new FakeDriver().enqueue({ rows }))
    expect(error).toMatchObject({ _tag: "TooManyRowsError", count: 2 })
  })
})
