import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { CapabilityError, type Database, MySQLDialect, db, pg, withMode } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const events = pg.table("events", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  at: pg.timestamp("at").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, layer: ReturnType<typeof FakeDatabaseLayer>) =>
  Effect.runPromise(Effect.provide(effect, layer))

describe("execution modes (spec §15.13, §15.17)", () => {
  const ISO = "2026-01-01T00:00:00Z"
  const rowsAt = () => new FakeDriver().enqueue({ rows: [{ at: ISO }] })

  it("safe mode (default) strictly decodes rows", async () => {
    const driver = rowsAt()
    const [row] = await run(db.select({ at: events.at }).from(events).all(), FakeDatabaseLayer(driver))
    expect(row!.at).toBeInstanceOf(Date)
  })

  it("trusted mode still strictly decodes rows", async () => {
    const driver = rowsAt()
    const [row] = await run(
      db.select({ at: events.at }).from(events).all(),
      withMode(FakeDatabaseLayer(driver), "trusted")
    )
    expect(row!.at).toBeInstanceOf(Date)
  })

  it("unsafe mode skips decoding and returns raw driver values", async () => {
    const driver = rowsAt()
    const [row] = await run(
      db.select({ at: events.at }).from(events).all(),
      withMode(FakeDatabaseLayer(driver), "unsafe")
    )
    // No schema decode: the raw ISO string passes through untouched.
    expect(row!.at).toBe(ISO)
  })

  it("unsafe mode never bypasses capability checks (spec §15.17)", async () => {
    // MySQL does not support insert...returning; even unsafe mode must reject it
    // before the driver, because no prior successful guard is recorded.
    const driver = new FakeDriver()
    const error = await run(
      Effect.flip(db.insert(events).values({ at: new Date() }).returning({ id: events.id }).run()),
      withMode(FakeDatabaseLayer(driver, { dialect: MySQLDialect }), "unsafe")
    )
    expect(error).toBeInstanceOf(CapabilityError)
    expect(driver.calls).toEqual([])
  })

  it("unsafe mode still binds parameters and reaches the driver for supported queries", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    const result = await run(
      db
        .insert(events)
        .values({ at: new Date("2026-02-02T00:00:00Z") })
        .run(),
      withMode(FakeDatabaseLayer(driver), "unsafe")
    )
    expect(result).toEqual({ rowCount: 1 })
    expect(driver.calls[0]!.sql).toContain("INSERT INTO")
  })
})
