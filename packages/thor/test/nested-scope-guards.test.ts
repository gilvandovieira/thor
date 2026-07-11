import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type Database, GuardError, alias, db, eq, exists, param, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("scope_users", { id: pg.text("id").primaryKey(), name: pg.text("name").notNull() })
const posts = pg.table("scope_posts", { id: pg.text("id").primaryKey(), userId: pg.text("user_id").notNull() })
const comments = pg.table("scope_comments", { id: pg.text("id").primaryKey() })

const runExit = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromiseExit(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("recursive mutation scope guards", () => {
  const invalidSubquery = db.select({ id: posts.id }).from(posts).where(eq(comments.id, posts.id))

  it.each([
    ["update", () => db.update(users).set({ name: "changed" }).where(exists(invalidSubquery)).run()],
    ["delete", () => db.delete(users).where(exists(invalidSubquery)).run()]
  ] as const)("rejects an out-of-scope column inside a nested %s predicate before I/O", async (_name, effect) => {
    const driver = new FakeDriver()
    const exit = await runExit(effect(), driver)

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain(GuardError.name)
    expect(JSON.stringify(exit)).toContain("table-scope")
    expect(driver.calls).toEqual([])
  })

  it("accepts deliberate outer correlation", async () => {
    const correlated = db.select({ id: posts.id }).from(posts).where(eq(posts.userId, users.id))
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    const exit = await runExit(db.update(users).set({ name: "changed" }).where(exists(correlated)).run(), driver)

    expect(exit._tag).toBe("Success")
    expect(driver.calls).toHaveLength(1)
  })

  it("rejects accidental correlation hidden by an equal SQL alias", async () => {
    const shadow = alias(users, "scope_users")
    const ambiguous = db.select({ id: shadow.id }).from(shadow).where(eq(users.id, shadow.id))
    const name = param("name", Schema.String)
    const mutation = db.update(users).set({ name }).where(exists(ambiguous))
    const driver = new FakeDriver()

    const direct = await runExit(mutation.run({ name: "changed" }), driver)
    expect(direct._tag).toBe("Failure")
    expect(driver.calls).toEqual([])
    expect(() => mutation.run().compile()).toThrow(/not in query scope/)
  })

  it("keeps two aliases of the same physical table distinct", async () => {
    const left = alias(users, "left_users")
    const right = alias(users, "right_users")
    const subquery = db.select({ id: left.id }).from(left).innerJoin(right, eq(left.id, right.id))
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    const exit = await runExit(db.delete(users).where(exists(subquery)).run(), driver)

    expect(exit._tag).toBe("Success")
  })
})
