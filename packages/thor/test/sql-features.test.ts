/**
 * SQL feature matrix, run at unit (SQL snapshot + required capabilities) and
 * fake-execution (params/cardinality/decode, capability-gated) levels across all
 * three dialects (spec §14.11). No database required.
 */
import { describe, expect, it } from "vitest"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import {
  ADVANCED_SQL_FEATURES,
  type ContractTestApi,
  LEVEL_1_2_FEATURES,
  ROUTINE_SQL_FEATURES,
  runSqlFeatureMatrix
} from "@gilvandovieira/thor/testing"

const noop = () => {}
const api: ContractTestApi = { describe, it, beforeAll: noop, afterAll: noop, beforeEach: noop, expect: expect as never }

for (const dialect of [PostgresDialect, SQLiteDialect, MySQLDialect]) {
  runSqlFeatureMatrix(api, { dialect, features: LEVEL_1_2_FEATURES })
  runSqlFeatureMatrix(api, { dialect, features: ADVANCED_SQL_FEATURES })
  runSqlFeatureMatrix(api, { dialect, features: ROUTINE_SQL_FEATURES })
}
