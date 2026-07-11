import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type Database, db, eq, param, pg, sql } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("snapshot_users", {
  id: pg.text("id").primaryKey(),
  email: pg.text("email").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("prepared and compiled handle snapshots", () => {
  it("does not observe mutation of a raw expression after prepare()", () => {
    const expression = sql`${users.id} IS NOT NULL`
    const prepared = db.select({ id: users.id }).from(users).where(expression).prepare("raw-snapshot")

    ;(expression.strings as string[])[0] = "1); DROP TABLE snapshot_users; --"

    expect(prepared.toSql().sql).toBe(
      'SELECT "snapshot_users"."id" AS "id" FROM "snapshot_users" WHERE "snapshot_users"."id" IS NOT NULL'
    )
  })

  it("does not observe mutation of a named parameter node after prepare()", async () => {
    const email = param("email", Schema.String)
    const prepared = db.select({ id: users.id }).from(users).where(eq(users.email, email)).prepare("param-snapshot")
    ;(email as { name: string }).name = "forged"
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(prepared.all({ email: "safe@example.com" }), driver)

    expect(driver.calls[0]?.params).toEqual(["safe@example.com"])
  })

  it("does not observe source mutation after compile()", async () => {
    const email = param("email", Schema.String)
    const compiled = db.select({ id: users.id }).from(users).where(eq(users.email, email)).all().compile()
    ;(email as { name: string }).name = "forged"
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(compiled.execute({ email: "safe@example.com" }), driver)

    expect(driver.calls[0]?.params).toEqual(["safe@example.com"])
  })
})
