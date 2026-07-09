import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver, preparedStatements = true) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver, { preparedStatements })))

describe("prepared-statement naming (spec §16)", () => {
  it("names parameterized statements with the stable compiled cacheKey", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, param("email", Schema.String)))

    await run(query.all({ email: "a@example.com" }), driver)

    expect(driver.preparedNames[0]).toBe(query.toSql().cacheKey)
  })

  it("does not prepare param-free statements (they may be multi-statement)", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(db.select({ id: users.id }).from(users).all(), driver)

    expect(driver.preparedNames[0]).toBeUndefined()
  })

  it("reuses one stable name across executions with different bound values", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] }, { rows: [] })
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, param("email", Schema.String)))

    await run(query.all({ email: "a@example.com" }), driver)
    await run(query.all({ email: "b@example.com" }), driver)

    expect(driver.preparedNames[0]).toBe(driver.preparedNames[1])
    expect(driver.calls[0]!.params).toEqual(["a@example.com"])
    expect(driver.calls[1]!.params).toEqual(["b@example.com"])
  })

  it("skips preparation entirely when preparedStatements is disabled", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, param("email", Schema.String)))

    await run(query.all({ email: "a@example.com" }), driver, false)

    expect(driver.preparedNames[0]).toBeUndefined()
  })
})
