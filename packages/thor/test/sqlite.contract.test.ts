/**
 * SQLite dialect contract suite (spec §2A.1, §14.11, §18.6).
 *
 * Runs the identical shared contract suite against in-memory `node:sqlite` — no
 * Docker, no `DATABASE_URL`, so it executes in the normal test run and gives the
 * SQLite adapter real end-to-end coverage. SQLite supports `RETURNING` natively,
 * so the capability-gated cases exercise the returning path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { NodeSQLiteDriverRuntime, RuntimeSQLiteLayer, SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { SQLITE_CONTRACT_RESET, type ContractTestApi, makeDialectContractSuite } from "@gilvandovieira/thor/testing"

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

const client = new DatabaseSync(":memory:")

makeDialectContractSuite(api, {
  name: "node:sqlite",
  dialect: SQLiteDialect,
  reset: SQLITE_CONTRACT_RESET,
  layer: RuntimeSQLiteLayer(client),
  runtime: NodeSQLiteDriverRuntime,
  teardown: () => client.close()
})
