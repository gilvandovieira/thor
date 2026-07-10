/**
 * SQL feature matrix — integration level against real in-memory SQLite
 * (spec §14.11). Proves the generated SQL for every Level 1–2 feature actually
 * parses and runs on the SQLite backend (the fake level covers decode).
 * No Docker; runs in the default test suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { NodeSQLiteLayer, SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import {
  ADVANCED_SQL_FEATURES,
  type ContractTestApi,
  DATA_TYPE_FEATURES,
  LEVEL_1_2_FEATURES,
  ROUTINE_SQL_FEATURES,
  TRANSACTION_DDL_FEATURES,
  SQLITE_FEATURE_RESET,
  runSqlFeatureIntegration
} from "@gilvandovieira/thor/testing"

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

const client = new DatabaseSync(":memory:")

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: [...LEVEL_1_2_FEATURES, ...DATA_TYPE_FEATURES, ...TRANSACTION_DDL_FEATURES, ...ADVANCED_SQL_FEATURES, ...ROUTINE_SQL_FEATURES],
  layer: NodeSQLiteLayer(client),
  reset: SQLITE_FEATURE_RESET
})

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: TRANSACTION_DDL_FEATURES.filter((feature) => feature.id === "transaction.isolation"),
  layer: NodeSQLiteLayer(client, { allowEmulation: true }),
  reset: SQLITE_FEATURE_RESET,
  allowEmulation: true
})

afterAll(() => client.close())
