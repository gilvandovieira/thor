import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { type Database, GuardError, db, eq, exists, pg } from "@gilvandovieira/thor"
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
})
