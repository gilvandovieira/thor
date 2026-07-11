import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { type Database, db, gt, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  age: pg.integer("age").nullable()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

const runExit = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromiseExit(Effect.provide(effect, FakeDatabaseLayer(driver)))

/**
 * P0.5 — `.one()`/`.maybeOne()` must probe at most two rows rather than
 * materializing an arbitrary result set.
 */
describe("cardinality probe caps .one()/.maybeOne() (P0.5)", () => {
  it("emits LIMIT 2 for .one() on an unlimited query", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await run(db.select({ id: users.id }).from(users).one(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 2$/)
  })

  it("emits LIMIT 2 for .maybeOne()", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    await run(db.select({ id: users.id }).from(users).maybeOne(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 2$/)
  })

  it("preserves a tighter user limit(1)", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await run(db.select({ id: users.id }).from(users).limit(1).one(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 1$/)
  })

  it("preserves limit(0)", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    const exit = await runExit(db.select({ id: users.id }).from(users).limit(0).one(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 0$/)
    expect(exit._tag).toBe("Failure") // NotFound
  })

  it("caps a larger user limit(50) down to 2 for the probe", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }, { id: "2" }] })
    const exit = await runExit(db.select({ id: users.id }).from(users).limit(50).one(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 2$/)
    expect(exit._tag).toBe("Failure") // TooManyRows
  })

  it("keeps OFFSET and applies the cap after it", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await run(db.select({ id: users.id }).from(users).offset(10).one(), driver)
    expect(driver.calls[0]!.sql).toMatch(/LIMIT 2 OFFSET 10$/)
  })

  it("returns none/some/too-many correctly", async () => {
    const none = new FakeDriver().enqueue({ rows: [] })
    const one = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    const many = new FakeDriver().enqueue({ rows: [{ id: "1" }, { id: "2" }] })

    expect(Option.isNone(await run(db.select({ id: users.id }).from(users).maybeOne(), none))).toBe(true)
    expect(await run(db.select({ id: users.id }).from(users).maybeOne(), one)).toEqual(Option.some({ id: "1" }))
    const exit = await runExit(db.select({ id: users.id }).from(users).where(gt(users.age, 0)).maybeOne(), many)
    expect(exit._tag).toBe("Failure") // TooManyRows
  })

  it("leaves .all() uncapped", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    await run(db.select({ id: users.id }).from(users).all(), driver)
    expect(driver.calls[0]!.sql).not.toMatch(/LIMIT/)
  })

  it("bounds a prepared handle's .one()/.maybeOne() to LIMIT 2 (Finding 5)", async () => {
    const handle = db.select({ id: users.id }).from(users).prepare("find")

    const oneDriver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await run(handle.one(), oneDriver)
    expect(oneDriver.calls[0]!.sql).toMatch(/LIMIT 2$/)

    const maybeDriver = new FakeDriver().enqueue({ rows: [] })
    await run(handle.maybeOne(), maybeDriver)
    expect(maybeDriver.calls[0]!.sql).toMatch(/LIMIT 2$/)

    // .all() through the same handle stays uncapped.
    const allDriver = new FakeDriver().enqueue({ rows: [] })
    await run(handle.all(), allDriver)
    expect(allDriver.calls[0]!.sql).not.toMatch(/LIMIT/)
  })
})
