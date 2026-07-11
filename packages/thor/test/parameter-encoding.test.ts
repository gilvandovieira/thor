import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { type Database, and, db, eq, param, pg, sql } from "@gilvandovieira/thor"
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

  it("snapshots dates and binary values before repeated and concurrent execution", async () => {
    const date = new Date("2025-01-02T03:04:05.000Z")
    const bytes = new Uint8Array([1, 2, 3])
    const buffer = Buffer.from([4, 5, 6])
    const effect = db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(sql`1`, date), eq(sql`2`, bytes), eq(sql`3`, buffer)))
      .all()
    date.setUTCFullYear(2030)
    bytes[0] = 9
    buffer[0] = 9
    const driver = new FakeDriver().enqueue({ rows: [] }, { rows: [] })

    await Promise.all([run(effect, driver), run(effect, driver)])

    for (const call of driver.calls) {
      expect(call.params[0]).toEqual(new Date("2025-01-02T03:04:05.000Z"))
      expect(call.params[1]).toEqual(new Uint8Array([1, 2, 3]))
      expect(call.params[2]).toEqual(Buffer.from([4, 5, 6]))
    }
  })

  it("recursively snapshots maps, sets, arrays, and null-prototype records when codecs allow them", async () => {
    const nested = Object.assign(Object.create(null) as Record<string, unknown>, { value: [1] })
    const map = new Map<unknown, unknown>([["key", nested]])
    const set = new Set<unknown>([nested])
    const effect = db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(sql`1`, map), eq(sql`2`, set)))
      .all()
    ;(nested.value as number[])[0] = 2
    map.set("later", true)
    set.add("later")
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(effect, driver)

    expect(driver.calls[0]?.params[0]).toEqual(new Map([["key", { value: [1] }]]))
    expect(driver.calls[0]?.params[1]).toEqual(new Set([{ value: [1] }]))
  })

  it("rejects mutable opaque inline instances and accepts frozen domain values", async () => {
    class DomainValue {
      constructor(readonly value: number) {}
    }
    expect(() => eq(sql`1`, new DomainValue(1))).toThrow(/Mutable inline DomainValue values are unsupported/)

    const frozen = Object.freeze(new DomainValue(1))
    const driver = new FakeDriver().enqueue({ rows: [] })
    await run(db.select({ id: events.id }).from(events).where(eq(sql`1`, frozen)).all(), driver)
    expect(driver.calls[0]?.params).toEqual([frozen])
  })
})
