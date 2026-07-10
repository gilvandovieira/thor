import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CapabilityError,
  DecodeError,
  GuardError,
  MySQLDialect,
  PostgresDialect,
  SQLiteDialect,
  db,
  pg
} from "@gilvandovieira/thor"
import {
  defineAggregateFunction,
  defineFunction,
  defineProcedure,
  defineTableFunction
} from "@gilvandovieira/thor/routine"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  score: pg.integer("score").nullable()
})

const integerArg = { dataType: "integer" as const, codec: Schema.Number }

describe("Level 9 routine query integration", () => {
  it("compiles declared scalar and aggregate calls with capability metadata", () => {
    const doubled = defineFunction("math.double_score", {
      args: [integerArg],
      returns: integerArg,
      volatility: "immutable"
    })
    const total = defineAggregateFunction("math.total_score", {
      args: [integerArg],
      returns: integerArg,
      volatility: "stable"
    })

    const query = db.select({ doubled: doubled(users.score), total: total(users.score) }).from(users)
    expect(query.toSql(PostgresDialect).sql).toBe(
      'SELECT "math"."double_score"("users"."score") AS "doubled", "math"."total_score"("users"."score") AS "total" FROM "users"'
    )
    expect(query.requiredCapabilities()).toEqual(["routine.functionCall"])
  })

  it("uses declared return codecs and surfaces routine decode failures", async () => {
    const doubled = defineFunction("double_score", {
      args: [integerArg],
      returns: integerArg,
      volatility: "immutable"
    })
    const query = db.select({ value: doubled(users.score) }).from(users)
    const driver = new FakeDriver().enqueue({ rows: [{ value: "not-a-number" }] })
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(query.all(), FakeDatabaseLayer(driver, { dialect: PostgresDialect })))
    )

    expect(error).toBeInstanceOf(DecodeError)
    expect(driver.calls).toHaveLength(1)
  })

  it("applies aggregation scope guards to declared aggregate functions", async () => {
    const total = defineAggregateFunction("total_score", {
      args: [integerArg],
      returns: integerArg
    })
    const invalid = db.select({ id: users.id, total: total(users.score) }).from(users)
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(invalid.all(), FakeDatabaseLayer(new FakeDriver())))
    )
    expect(error).toBeInstanceOf(GuardError)
    expect((error as GuardError).guard).toBe("aggregation-scope")
  })

  it("turns table-valued functions into typed relation sources", () => {
    const series = defineTableFunction("public.generate_series", {
      args: { start: integerArg, stop: integerArg },
      returns: { value: integerArg },
      volatility: "immutable"
    }).call({ start: 1, stop: 3 }, "series")
    const query = db.select({ value: series.field("value") }).from(series)

    expect(query.toSql(PostgresDialect).sql).toBe(
      'SELECT "series"."value" AS "value" FROM "public"."generate_series"($1::integer, $2::integer) "series"("value")'
    )
    expect(query.requiredCapabilities()).toEqual(["routine.tableValuedFunction"])
  })

  it("builds inspectable, bound procedure commands", () => {
    const cleanup = defineProcedure("maintenance.cleanup", {
      args: { before: { dataType: "text", codec: Schema.String } },
      effects: {
        mutates: ["sessions"],
        idempotency: "idempotent",
        requiresTransaction: false
      }
    })
    const call = cleanup.call({ before: "2026-01-01" })
    const compiled = call.toSql(MySQLDialect)

    expect(compiled.sql).toBe("CALL `maintenance`.`cleanup`(?)")
    expect(compiled.paramOrder).toHaveLength(1)
    expect(call.requiredCapabilities()).toEqual(["routine.procedureCall"])
    expect(call.inspect().procedure).toBe("maintenance.cleanup")
  })

  it("rejects unsupported routine kinds before SQLite drivers", async () => {
    const scalar = defineFunction("double_score", { args: [integerArg], returns: integerArg })
    const procedure = defineProcedure("cleanup", {
      args: {},
      effects: { mutates: [], idempotency: "unknown", requiresTransaction: false }
    })
    const effects = [
      db.select({ value: scalar(users.score) }).from(users).all(),
      procedure.call({}).run()
    ]

    for (const effect of effects) {
      const driver = new FakeDriver()
      const error = await Effect.runPromise(
        Effect.flip(Effect.provide(effect, FakeDatabaseLayer(driver, { dialect: SQLiteDialect })))
      )
      expect(error).toBeInstanceOf(CapabilityError)
      expect(driver.calls).toEqual([])
    }
  })
})

describe("Epic R2 — declared functions as window functions (§14.2)", () => {
  it("applies a declared aggregate over a window, capability-gated", () => {
    const total = defineAggregateFunction("total_score", { args: [integerArg], returns: integerArg })
    const query = db
      .select({ id: users.id, running: total(users.score).over({ partitionBy: [users.id] }) })
      .from(users)

    expect(query.toSql(PostgresDialect).sql.toLowerCase()).toContain('over (partition by "users"."id")')
    // Windowing adds select.windowFunctions on top of the routine capability.
    expect(query.requiredCapabilities()).toEqual(
      expect.arrayContaining(["routine.functionCall", "select.windowFunctions"])
    )
  })

  it("a windowed aggregate does not trigger the aggregation-scope guard", async () => {
    const total = defineAggregateFunction("total_score", { args: [integerArg], returns: integerArg })
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1", running: 3 }] })
    const rows = await Effect.runPromise(
      Effect.provide(
        db.select({ id: users.id, running: total(users.score).over() }).from(users).all(),
        FakeDatabaseLayer(driver, { dialect: PostgresDialect })
      )
    )
    expect(rows).toEqual([{ id: "u1", running: 3 }])
  })
})

describe("Epic R3 — procedure transaction metadata (§14.5, §14.6)", () => {
  const migrate = defineProcedure("do_migrate", {
    args: {},
    effects: { mutates: ["ledger"], idempotency: "non-idempotent", requiresTransaction: true }
  })

  it("fails before the driver when a required transaction is absent", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 1 })
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(migrate.call({}).run(), FakeDatabaseLayer(driver, { dialect: PostgresDialect })))
    )
    expect(error).toBeInstanceOf(GuardError)
    expect((error as GuardError).guard).toBe("procedure-requires-transaction")
    expect(driver.calls).toEqual([])
  })

  it("runs when called inside db.transaction", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 0 }, { rowCount: 1 }, { rowCount: 0 })
    const result = await Effect.runPromise(
      Effect.provide(db.transaction(migrate.call({}).run()), FakeDatabaseLayer(driver, { dialect: PostgresDialect }))
    )
    expect(result).toEqual({ rowCount: 1 })
    expect(driver.calls.some((call) => call.sql.includes("CALL"))).toBe(true)
  })
})
