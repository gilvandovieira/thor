/**
 * Bun-only SQLite contract harness.
 *
 * This is intentionally separate from the Node/Vitest harness: it imports
 * Bun's test runner and built-in SQLite client directly, then registers the
 * identical runner-agnostic Thor contract suite and fixture reset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSQLiteDriverRuntime, BunSQLiteLayer, RuntimeSQLiteLayer, SQLiteDialect } from "@gilvandovieira/thor/sqlite"
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

afterAll(() => client.close())
