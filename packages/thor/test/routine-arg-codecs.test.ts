import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type Database, db, pg } from "@gilvandovieira/thor"
import { defineFunction, defineProcedure } from "@gilvandovieira/thor/routine"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", { id: pg.uuid("id").primaryKey().defaultRandom() })

// A transforming codec: decoded Date <-> ISO string reaching the driver.
const DateArg = {
  dataType: "timestamptz" as const,
  codec: Schema.transform(Schema.String, Schema.DateFromSelf, {
    decode: (s) => new Date(s),
    encode: (d) => d.toISOString(),
    strict: true
  })
}
const intArg = { dataType: "integer" as const, codec: Schema.Number }

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))
const runExit = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromiseExit(Effect.provide(effect, FakeDatabaseLayer(driver)))

/**
 * Finding 6 — declared routine argument codecs must validate and encode inline
 * values, and named routine calls must reject missing/unknown arguments.
 */
describe("routine argument codecs and validation (Finding 6)", () => {
  const when = new Date("2024-01-02T03:04:05.000Z")

  it("encodes a function argument through its declared codec at execution", async () => {
    const at = defineFunction("at_fn", { args: [DateArg], returns: intArg, volatility: "immutable" })
    const driver = new FakeDriver().enqueue({ rows: [{ v: 1 }] })
    await run(
      db
        .select({ v: at(when) })
        .from(users)
        .all(),
      driver
    )
    // The inline Date is encoded to an ISO string parameter, not passed raw.
    expect(driver.calls[0]!.params).toEqual([when.toISOString()])
  })

  it("rejects an invalid procedure argument before the driver runs", async () => {
    const proc = defineProcedure("do_thing", {
      args: { at: DateArg },
      effects: { mutates: [], idempotency: "non-idempotent", requiresTransaction: false }
    })
    const driver = new FakeDriver().enqueue({ rowCount: 0 })
    const exit = await runExit(proc.call({ at: "not-a-date" as unknown as Date }).run(), driver)
    expect(exit._tag).toBe("Failure")
    expect(driver.calls.length).toBe(0)
  })

  it("rejects a missing named procedure argument at construction", () => {
    const proc = defineProcedure("need_arg", {
      args: { at: DateArg },
      effects: { mutates: [], idempotency: "non-idempotent", requiresTransaction: false }
    })
    expect(() => proc.call({} as never)).toThrow(expect.objectContaining({ _tag: "RoutineError" }))
  })

  it("rejects an unknown named procedure argument at construction", () => {
    const proc = defineProcedure("known_arg", {
      args: { at: DateArg },
      effects: { mutates: [], idempotency: "non-idempotent", requiresTransaction: false }
    })
    expect(() => proc.call({ at: when, bogus: 1 } as never)).toThrow(expect.objectContaining({ _tag: "RoutineError" }))
  })

  it("encodes a valid procedure argument through its codec", async () => {
    const proc = defineProcedure("ok_arg", {
      args: { at: DateArg },
      effects: { mutates: [], idempotency: "non-idempotent", requiresTransaction: false }
    })
    const driver = new FakeDriver().enqueue({ rowCount: 0 })
    await run(proc.call({ at: when }).run(), driver)
    expect(driver.calls[0]!.params).toEqual([when.toISOString()])
  })
})
