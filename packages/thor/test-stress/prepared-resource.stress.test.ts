import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Database, type DatabaseService, PostgresDialect, db, eq, param, pg } from "@gilvandovieira/thor"
import { makeQueryCaches } from "../src/execution/cache.js"
import { FakeDriver } from "@gilvandovieira/thor/testing"

describe("long-lived prepared-resource stress", () => {
  it("keeps 10,000 unique shapes within the native registry and a reviewed heap envelope", async () => {
    const shapes = 10_000
    const bound = 100
    const driver = new FakeDriver()
    const caches = makeQueryCaches({ preparedMaxSize: bound })
    const layer = Layer.succeed(Database, {
      dialect: PostgresDialect,
      driver: driver.driver,
      allowEmulation: false,
      preparedStatements: true,
      queryCache: caches
    } satisfies DatabaseService)
    const heapBefore = process.memoryUsage().heapUsed

    for (let index = 0; index < shapes; index++) {
      const table = pg.table(`stress_${index}`, { id: pg.text("id").primaryKey() })
      const value = param(`id_${index}`, Schema.String)
      await Effect.runPromise(
        Effect.provide(
          db
            .select({ id: table.id })
            .from(table)
            .where(eq(table.id, value))
            .all({ [`id_${index}`]: "x" } as never),
          layer
        )
      )
    }

    const prepared = caches.stats().find((entry) => entry.name === "prepared")!
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore
    expect(prepared.size).toBe(bound)
    expect(prepared.admissions).toBe(shapes)
    expect(prepared.physicalReleases).toBe(shapes - bound)
    expect(driver.releasedPreparedNames).toHaveLength(shapes - bound)
    expect(heapGrowth).toBeLessThan(256 * 1024 * 1024)
  }, 120_000)
})
