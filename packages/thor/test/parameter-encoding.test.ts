import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { type Database, db, eq, param, pg } from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

// `timestamp` decodes to Date and its codec validates the value is a real Date
// on encode — a plain string is rejected. Perfect to prove inline values are
// validated/encoded through the column codec, exactly like named params.
const events = pg.table("events", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  at: pg.timestamp("at").notNull(),
  name: pg.text("name").nullable(),
  metadata: pg.jsonb("metadata").nullable()
})

const TimestampSchema = events.at.def.codec

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

const runExit = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromiseExit(Effect.provide(effect, FakeDatabaseLayer(driver)))

/**
 * P0.2 — every application value (inline or named) must be validated and encoded
 * through its declared codec before reaching the driver.
 */
describe("consistent parameter encoding (P0.2)", () => {
  const when = new Date("2024-01-02T03:04:05.000Z")

  it("encodes inline values through the column codec", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    await run(db.select({ id: events.id }).from(events).where(eq(events.at, when)).all(), driver)
    expect(driver.calls[0]!.params).toEqual([when])
  })

  it("produces identical driver values for inline vs named", async () => {
    const inlineDriver = new FakeDriver().enqueue({ rows: [] })
    const namedDriver = new FakeDriver().enqueue({ rows: [] })

    await run(db.select({ id: events.id }).from(events).where(eq(events.at, when)).all(), inlineDriver)
    await run(
      db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.at, param("at", TimestampSchema)))
        .all({ at: when }),
      namedDriver
    )

    expect(inlineDriver.calls[0]!.params).toEqual(namedDriver.calls[0]!.params)
  })

  it("rejects an invalid inline value before the driver runs", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    // bypass TS: `at` must be a Date, force a bad string through a cast
    const bad = db
      .insert(events)
      .values({ at: "not-a-date" as unknown as Date })
      .run()

    const exit = await runExit(bad, driver)
    expect(exit._tag).toBe("Failure")
    expect(driver.calls.length).toBe(0)
  })

  it("rejects an invalid named value before the driver runs", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] })
    const bad = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.at, param("at", TimestampSchema)))
      .all({ at: "not-a-date" as unknown as Date })

    const exit = await runExit(bad, driver)
    expect(exit._tag).toBe("Failure")
    expect(driver.calls.length).toBe(0)
  })

  it("encodes inline null for a nullable column", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    await run(db.insert(events).values({ at: when, name: null }).run(), driver)
    // name encodes null through Schema.NullOr; at passes the Date through
    expect(driver.calls[0]!.params).toContain(null)
    expect(driver.calls[0]!.params).toContainEqual(when)
  })

  it("snapshots mutable inline values when constructing a direct terminal", async () => {
    const metadata = { tags: ["original"] }
    const effect = db.insert(events).values({ at: when, metadata }).run()
    metadata.tags[0] = "mutated"
    const driver = new FakeDriver().enqueue({ rowCount: 1 })

    await run(effect, driver)

    expect(driver.calls[0]!.params).toContainEqual({ tags: ["original"] })
  })
})
