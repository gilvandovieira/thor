import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { type Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

/**
 * P0.3 — Thor implements the *shape-only* compilation model: `.compile()`
 * represents a reusable query shape and rejects captured inline values, which
 * must instead be named `param()` values supplied at execution.
 */
describe("compiled-query shape-only value semantics (P0.3)", () => {
  it("rejects compiling a query that captures an inline value", () => {
    expect(() =>
      db.select({ id: users.id }).from(users).where(eq(users.email, "ada@example.com")).one().compile()
    ).toThrow(expect.objectContaining({ _tag: "GuardError", guard: "prepared-values" }))
  })

  it("compiles a shape with named parameters and supplies values at execute()", async () => {
    const FindByEmail = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
      .one()
      .compile()

    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await run(FindByEmail.execute({ email: "ada@example.com" }), driver)
    expect(driver.calls[0]!.params).toEqual(["ada@example.com"])
  })

  it("keeps per-execution values out of the cache key", () => {
    const FindByEmail = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
      .one()
      .compile()
    // cacheKey is value-independent (structural only)
    expect(FindByEmail.cacheKey).toMatch(/^postgres:[0-9a-f]{8}:[0-9a-f]{8}$/)
  })

  it("inspection distinguishes captured constants from named parameters", () => {
    const inlineShape = db.select({ id: users.id }).from(users).where(eq(users.email, "ada@example.com")).inspect()
    expect(inlineShape.params).toEqual([]) // no named params
    expect(inlineShape.constants.length).toBe(1) // one captured constant

    const namedShape = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
      .inspect()
    expect(namedShape.params).toEqual(["email"])
    expect(namedShape.constants).toEqual([])
  })
})
