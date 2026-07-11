import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import {
  Database,
  type DatabaseService,
  MySQLDialect,
  PostgresDialect,
  db,
  eq,
  normalizeMode,
  param,
  pg,
  resolveDecodeMode,
  withMode
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"
import { BoundedLruCache, type QueryCaches, WeakCacheLayer, makeQueryCaches } from "../src/execution/cache.js"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const events = pg.table("events", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  at: pg.timestamp("at").notNull()
})

/** Build a fake `Database` layer with an explicit query-cache registry we can inspect. */
const layerWith = (caches: QueryCaches, driver: FakeDriver, dialect = PostgresDialect): Layer.Layer<Database> => {
  const service: DatabaseService = {
    dialect,
    driver: driver.driver,
    allowEmulation: false,
    preparedStatements: true,
    queryCache: caches
  }
  return Layer.succeed(Database, service)
}

const run = <A, E>(effect: Effect.Effect<A, E, Database>, layer: Layer.Layer<Database>) =>
  Effect.runPromise(Effect.provide(effect, layer))

const statOf = (caches: QueryCaches, name: string) => caches.stats().find((s) => s.name === name)!

describe("Epic L — cache layers (spec §9.1)", () => {
  it("WeakCacheLayer records hits and misses and computes once per key", () => {
    const layer = new WeakCacheLayer<object, number>("shape")
    const a = {}
    let computed = 0
    expect(
      layer.getOrCompute(a, () => {
        computed++
        return 1
      })
    ).toBe(1)
    expect(
      layer.getOrCompute(a, () => {
        computed++
        return 2
      })
    ).toBe(1)
    expect(computed).toBe(1)
    const stats = layer.stats()
    expect(stats).toMatchObject({
      name: "shape",
      hits: 1,
      misses: 1,
      evictions: 0,
      size: undefined,
      maxSize: undefined
    })
  })

  it("BoundedLruCache evicts least-recently-used entries and counts evictions", () => {
    const layer = new BoundedLruCache<object, number>("compile", 2)
    const a = { k: "a" }
    const b = { k: "b" }
    const c = { k: "c" }
    layer.getOrCompute(a, () => 1)
    layer.getOrCompute(b, () => 2)
    // Touch `a` so `b` becomes least-recently-used.
    expect(layer.getOrCompute(a, () => 99)).toBe(1)
    layer.getOrCompute(c, () => 3) // evicts b
    expect(layer.peek(b)).toBeUndefined()
    expect(layer.peek(a)).toBe(1)
    expect(layer.peek(c)).toBe(3)
    const stats = layer.stats()
    expect(stats).toMatchObject({ name: "compile", evictions: 1, size: 2, maxSize: 2 })
  })

  it("rejects a non-positive bound", () => {
    expect(() => new BoundedLruCache("x", 0)).toThrow(RangeError)
    expect(() => new BoundedLruCache("x", -1)).toThrow(RangeError)
  })

  it("QueryCaches names all five layers", () => {
    const caches = makeQueryCaches()
    expect(caches.stats().map((s) => s.name)).toEqual(["shape", "compile", "prepared", "decoder", "capability"])
  })

  it("makeQueryCaches defaults to unbounded (weak) layers and bounds when maxSize is set", () => {
    expect(statOf(makeQueryCaches(), "compile").maxSize).toBeUndefined()
    expect(statOf(makeQueryCaches({ maxSize: 5 }), "compile").maxSize).toBe(5)
  })
})

describe("Epic L — withQueryCache wiring (spec §9.3)", () => {
  it("memoizes shape/compile/decoder across executions of the same query", async () => {
    const caches = makeQueryCaches()
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] }, { rows: [{ id: "u2" }] })
    // One builder instance → one stable IR identity → cache hits on the 2nd run.
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
    const layer = layerWith(caches, driver)

    await run(query.all({ email: "a@example.com" }), layer)
    await run(query.all({ email: "b@example.com" }), layer)

    // Second run is a hit on every shape-keyed layer.
    expect(statOf(caches, "compile")).toMatchObject({ hits: 1, misses: 1 })
    expect(statOf(caches, "shape")).toMatchObject({ hits: 1, misses: 1 })
    // Parameterized shape is registered once, reused once.
    expect(statOf(caches, "prepared")).toMatchObject({ hits: 1, misses: 1, size: 1 })
  })

  it("bounds retained shapes and evicts under maxSize", async () => {
    const caches = makeQueryCaches({ maxSize: 1 })
    const driver = new FakeDriver()
    // Two distinct query shapes → the compile layer can retain only one.
    driver.enqueue({ rows: [] }, { rows: [] })
    await run(db.select({ id: users.id }).from(users).all(), layerWith(caches, driver))
    await run(db.select({ email: users.email }).from(users).all(), layerWith(caches, driver))
    const compile = statOf(caches, "compile")
    expect(compile.size).toBe(1)
    expect(compile.evictions).toBeGreaterThanOrEqual(1)
  })

  it("bounds actual connection-scoped prepared resources and releases LRU evictions", async () => {
    const caches = makeQueryCaches({ maxSize: 2 })
    const driver = new FakeDriver().enqueue({ rows: [] }, { rows: [] }, { rows: [] })
    const first = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
    const second = db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, param("id", Schema.String)))
    const third = db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, param("otherEmail", Schema.String)))
    const layer = layerWith(caches, driver)

    await run(first.all({ email: "a@example.com" }), layer)
    await run(second.all({ id: "u1" }), layer)
    await run(third.all({ otherEmail: "b@example.com" }), layer)

    expect(driver.releasedPreparedNames).toEqual([first.toSql().cacheKey])
    expect(statOf(caches, "prepared")).toMatchObject({ misses: 3, evictions: 1, size: 2, maxSize: 2 })
  })

  it("default (no withQueryCache) still executes correctly", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })
    const rows = await run(db.select({ id: users.id }).from(users).all(), FakeDatabaseLayer(driver))
    expect(rows).toEqual([{ id: "u1" }])
  })

  it("db.withQueryCache is sugar for the standalone wrapper", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })
    const layer = db.withQueryCache(FakeDatabaseLayer(driver), { maxSize: 4 })
    await expect(run(db.select({ id: users.id }).from(users).all(), layer)).resolves.toEqual([{ id: "u1" }])
  })
})

describe("Epic L — modes renamed to unsafe-hot (spec §10)", () => {
  const ISO = "2026-01-01T00:00:00Z"

  it("normalizeMode maps the deprecated unsafe alias to unsafe-hot", () => {
    expect(normalizeMode("unsafe")).toBe("unsafe-hot")
    expect(normalizeMode("unsafe-hot")).toBe("unsafe-hot")
    expect(normalizeMode("trusted")).toBe("trusted")
    expect(normalizeMode("safe")).toBe("safe")
  })

  it("resolveDecodeMode skips decode for unsafe-hot and its alias", () => {
    expect(resolveDecodeMode("unsafe-hot")).toBe("trusted")
    expect(resolveDecodeMode("unsafe")).toBe("trusted")
    expect(resolveDecodeMode("safe")).toBe("strict")
  })

  it("withMode(..., 'unsafe-hot') skips decoding and returns raw driver values", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ at: ISO }] })
    const [row] = await run(
      db.select({ at: events.at }).from(events).all(),
      withMode(FakeDatabaseLayer(driver), "unsafe-hot")
    )
    expect(row!.at).toBe(ISO)
  })

  it("db.withMode is sugar for the standalone wrapper", async () => {
    const driver = new FakeDriver().enqueue({ rows: [{ at: ISO }] })
    const [row] = await run(
      db.select({ at: events.at }).from(events).all(),
      db.withMode(FakeDatabaseLayer(driver), "trusted")
    )
    expect(row!.at).toBeInstanceOf(Date)
  })
})

describe("Epic L — precompilation modes (spec §9.4)", () => {
  const FindUserByEmail = db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, param("email", Schema.String)))
    .one()

  it("compilePrepared() carries the prepared-statement name to the driver", async () => {
    const handle = FindUserByEmail.compilePrepared()
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1", email: "a@example.com" }] })
    await run(handle.execute({ email: "a@example.com" }), FakeDatabaseLayer(driver, { preparedStatements: false }))
    // prepare:true overrides the service policy that disabled prepared statements.
    expect(driver.preparedNames).toEqual([handle.cacheKey])
  })

  it("compile({ prepare: false }) disables the prepared-statement name", async () => {
    const handle = FindUserByEmail.compile(PostgresDialect, { prepare: false })
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1", email: "a@example.com" }] })
    await run(handle.execute({ email: "a@example.com" }), FakeDatabaseLayer(driver))
    expect(driver.preparedNames).toEqual([undefined])
  })

  it("compileUnsafeHot() prepares and skips decode", async () => {
    const ISO = "2026-03-03T00:00:00Z"
    const handle = db
      .select({ at: events.at })
      .from(events)
      .where(eq(events.at, param("at", Schema.Date)))
      .all()
      .compileUnsafeHot()
    const driver = new FakeDriver().enqueue({ rows: [{ at: ISO }] })
    const [row] = await run(
      handle.execute({ at: new Date(ISO) }),
      FakeDatabaseLayer(driver, { preparedStatements: false })
    )
    // unsafe-hot skips schema decode: the raw ISO string passes through.
    expect(row!.at).toBe(ISO)
    expect(driver.preparedNames[0]).toBe(handle.cacheKey)
  })

  it("compileUnsafeHot() still enforces capability guards (spec §10.3, §15.17)", () => {
    const returning = db
      .insert(users)
      .values({ id: param("id", Schema.String), email: param("email", Schema.String) })
      .returning({ id: users.id })
      .one()
    // MySQL cannot RETURNING; guard fails at compile time even for unsafe-hot.
    expect(() => returning.compileUnsafeHot(MySQLDialect)).toThrow()
  })
})
