import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { db, pg, withObservability, type QueryObservabilityEvent } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", { id: pg.uuid("id").primaryKey().defaultRandom() })

const collect = (driver: FakeDriver, events: QueryObservabilityEvent[]) =>
  withObservability(FakeDatabaseLayer(driver), {
    onEvent: (event) => {
      if (event.kind === "query") events.push(event)
    }
  })

/**
 * Finding 14 — `.one()`/`.maybeOne()` cardinality errors must be part of the
 * observed query event (with an `errorTag`), not reported as a successful query.
 */
describe("cardinality errors are observed (Finding 14)", () => {
  it("tags a NotFoundError from .one() on the query event", async () => {
    const events: QueryObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({ rows: [] })
    await Effect.runPromiseExit(Effect.provide(db.select({ id: users.id }).from(users).one(), collect(driver, events)))
    expect(events).toHaveLength(1)
    expect(events[0]!.errorTag).toBe("NotFoundError")
  })

  it("tags a TooManyRowsError from .one() on the query event", async () => {
    const events: QueryObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }, { id: "2" }] })
    await Effect.runPromiseExit(Effect.provide(db.select({ id: users.id }).from(users).one(), collect(driver, events)))
    expect(events).toHaveLength(1)
    expect(events[0]!.errorTag).toBe("TooManyRowsError")
  })

  it("tags a TooManyRowsError from .maybeOne()", async () => {
    const events: QueryObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }, { id: "2" }] })
    await Effect.runPromiseExit(
      Effect.provide(db.select({ id: users.id }).from(users).maybeOne(), collect(driver, events))
    )
    expect(events[0]!.errorTag).toBe("TooManyRowsError")
  })

  it("reports a successful single-row .one() with no errorTag and rowCount 1", async () => {
    const events: QueryObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({ rows: [{ id: "1" }] })
    await Effect.runPromise(Effect.provide(db.select({ id: users.id }).from(users).one(), collect(driver, events)))
    expect(events[0]!.errorTag).toBeUndefined()
    expect(events[0]!.rowCount).toBe(1)
  })
})
