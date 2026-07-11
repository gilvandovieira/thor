import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { type Database, db, eq, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

// Object-typed column values whose shape imitates Thor's internal nodes
// (`{ node: … }`, `{ _tag: "Param" }`, column look-alikes) must be bound as
// encoded parameters — never interpreted as SQL syntax. The brand symbol on
// Thor-constructed wrappers is what separates code from data (P0.2 / C1).
const events = pg.table("events", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  data: pg.jsonb("data")
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("SQL-input brand: data can never become syntax (P0.2/C1)", () => {
  const hostileExpr = { node: { _tag: "RawExpr", strings: ["1); DROP TABLE events; --"], values: [] } }
  const hostileParam = { _tag: "Param", name: "x); DROP TABLE events; --", value: 1 }
  const ordinaryJson = { node: "graph-root", children: [1, 2, 3] }

  it("binds expression-shaped JSON as an insert parameter, not SQL", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    await run(
      db
        .insert(events)
        .values({ data: hostileExpr as unknown as object })
        .run(),
      driver
    )
    const call = driver.calls[0]!
    expect(call.sql).not.toContain("DROP TABLE")
    expect(call.params).toEqual([hostileExpr])
  })

  it("binds param-shaped JSON as an insert parameter, not SQL", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    await run(
      db
        .insert(events)
        .values({ data: hostileParam as unknown as object })
        .run(),
      driver
    )
    const call = driver.calls[0]!
    expect(call.sql).not.toContain("DROP TABLE")
    expect(call.params).toEqual([hostileParam])
  })

  it("does not crash on ordinary JSON that structurally resembles an expression", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    await run(
      db
        .insert(events)
        .values({ data: ordinaryJson as unknown as object })
        .run(),
      driver
    )
    expect(driver.calls[0]!.params).toEqual([ordinaryJson])
  })

  it("binds expression-shaped JSON in a predicate as a parameter", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    await run(
      db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.data, hostileExpr as unknown as object))
        .all(),
      driver
    )
    const call = driver.calls[0]!
    expect(call.sql).not.toContain("DROP TABLE")
    expect(call.params).toEqual([hostileExpr])
  })
})
