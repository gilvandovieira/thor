import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Database,
  type DatabaseService,
  MySQLDialect,
  PostgresDialect,
  db,
  eq,
  mysql,
  param,
  pg
} from "@gilvandovieira/thor"
import { makeMySQLDriver } from "@gilvandovieira/thor/mysql"
import { FakeDriver } from "@gilvandovieira/thor/testing"
import { type QueryCaches, makeQueryCaches } from "../src/execution/cache.js"

const stats = (caches: QueryCaches) => caches.stats().find((entry) => entry.name === "prepared")!

const exerciseShapes = async (count: number, caches: QueryCaches, driver: FakeDriver): Promise<void> => {
  const layer = Layer.succeed(Database, {
    dialect: PostgresDialect,
    driver: driver.driver,
    allowEmulation: false,
    preparedStatements: true,
    queryCache: caches
  } satisfies DatabaseService)

  for (let index = 0; index < count; index++) {
    const table = pg.table(`prepared_shape_${index}`, { id: pg.text("id").primaryKey() })
    const query = db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, param(`id_${index}`, Schema.String)))
    await Effect.runPromise(Effect.provide(query.all({ [`id_${index}`]: String(index) } as never), layer))
  }
}

describe("prepared resource bounds", () => {
  it("bounds default prepared admission independently of unbounded shape caches", async () => {
    const caches = makeQueryCaches()
    const driver = new FakeDriver()

    await exerciseShapes(150, caches, driver)

    expect(stats(caches)).toMatchObject({ size: 100, maxSize: 100, evictions: 50 })
    expect(driver.releasedPreparedNames).toHaveLength(50)
  })

  it("keeps maxSize and preparedMaxSize independent", async () => {
    const shapeBoundOnly = makeQueryCaches({ maxSize: 10 })
    await exerciseShapes(20, shapeBoundOnly, new FakeDriver())
    expect(stats(shapeBoundOnly)).toMatchObject({ size: 20, maxSize: 100 })

    const preparedBound = makeQueryCaches({ maxSize: 10_000, preparedMaxSize: 7 })
    const driver = new FakeDriver()
    await exerciseShapes(20, preparedBound, driver)
    expect(stats(preparedBound)).toMatchObject({ size: 7, maxSize: 7, evictions: 13 })
    expect(driver.releasedPreparedNames).toHaveLength(13)
  })

  it("does not claim eviction when a MySQL client cannot release native statements", async () => {
    const retained = new Set<string>()
    const client = {
      query: async () => [[], []] as const,
      execute: async (sql: string) => {
        retained.add(sql)
        return [[], []] as const
      }
    }
    const caches = makeQueryCaches({ preparedMaxSize: 1 })
    const layer = Layer.succeed(Database, {
      dialect: MySQLDialect,
      driver: makeMySQLDriver(client),
      allowEmulation: false,
      preparedStatements: true,
      queryCache: caches
    } satisfies DatabaseService)

    for (let index = 0; index < 3; index++) {
      const table = mysql.table(`mysql_prepared_${index}`, { id: mysql.text("id").primaryKey() })
      const query = db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, param(`id_${index}`, Schema.String)))
      await Effect.runPromise(Effect.provide(query.all({ [`id_${index}`]: String(index) } as never), layer))
    }

    expect(retained.size).toBeLessThanOrEqual(1)
    expect(stats(caches).size).toBe(retained.size)
  })
})
