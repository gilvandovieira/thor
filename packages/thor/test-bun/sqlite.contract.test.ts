/**
 * Bun-only SQLite contract harness.
 *
 * This is intentionally separate from the Node/Vitest harness: it imports
 * Bun's test runner and built-in SQLite client directly, then registers the
 * identical runner-agnostic Thor contract suite and fixture reset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import {
  BunSQLiteDriverRuntime,
  BunSQLiteLayer,
  RuntimeSQLiteLayer,
  SQLiteDialect,
  makeBunSQLiteDriver
} from "@gilvandovieira/thor/sqlite"
import {
  ADVANCED_SQL_FEATURES,
  DATA_TYPE_FEATURES,
  LEVEL_1_2_FEATURES,
  ROUTINE_SQL_FEATURES,
  TRANSACTION_DDL_FEATURES,
  SQLITE_CONTRACT_RESET,
  SQLITE_FEATURE_RESET,
  type ContractTestApi,
  makeDialectContractSuite,
  runSqlFeatureIntegration
} from "@gilvandovieira/thor/testing"

const api: ContractTestApi = {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect: expect as never
}

const client = new Database(":memory:")

makeDialectContractSuite(api, {
  name: "bun:sqlite",
  dialect: SQLiteDialect,
  reset: SQLITE_CONTRACT_RESET,
  layer: RuntimeSQLiteLayer(client),
  runtime: BunSQLiteDriverRuntime
})

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: [...LEVEL_1_2_FEATURES, ...DATA_TYPE_FEATURES, ...TRANSACTION_DDL_FEATURES, ...ADVANCED_SQL_FEATURES, ...ROUTINE_SQL_FEATURES],
  layer: BunSQLiteLayer(client),
  reset: SQLITE_FEATURE_RESET
})

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: TRANSACTION_DDL_FEATURES.filter((feature) => feature.id === "transaction.isolation"),
  layer: BunSQLiteLayer(client, { allowEmulation: true }),
  reset: SQLITE_FEATURE_RESET,
  allowEmulation: true
})

describe("bun:sqlite statement ownership", () => {
  it("finalizes transient, collision, and cached statements exactly once", async () => {
    const native = new Database(":memory:")
    let prepared = 0
    let finalized = 0
    let active = 0
    const wrapper = {
      prepare: (sql: string) => {
        const statement = native.prepare(sql)
        prepared++
        active++
        let released = false
        return {
          all: (...params: any[]) => statement.all(...params),
          run: (...params: any[]) => statement.run(...params),
          finalize: () => {
            if (released) throw new Error("double finalize")
            released = true
            statement.finalize()
            finalized++
            active--
          }
        }
      },
      exec: (sql: string) => native.exec(sql)
    }
    const driver = makeBunSQLiteDriver(wrapper)

    try {
      await Effect.runPromise(driver.query("select 1 as value", []))
      await Effect.runPromise(driver.execute("create table items (id integer)", []))
      await Effect.runPromise(driver.query("select 2 as value", [], "same"))
      await Effect.runPromise(driver.query("select 3 as value", [], "same"))
      expect({ prepared, finalized, active }).toEqual({ prepared: 4, finalized: 3, active: 1 })
      await Effect.runPromise(driver.clearPrepared!())
      expect({ prepared, finalized, active }).toEqual({ prepared: 4, finalized: 4, active: 0 })
    } finally {
      native.close()
    }
  })
})

afterAll(() => client.close())
