/**
 * Bun-only SQLite contract harness.
 *
 * This is intentionally separate from the Node/Vitest harness: it imports
 * Bun's test runner and built-in SQLite client directly, then registers the
 * identical runner-agnostic Thor contract suite and fixture reset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSQLiteLayer, SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import {
  SQLITE_CONTRACT_RESET,
  type ContractTestApi,
  makeDialectContractSuite
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
  layer: BunSQLiteLayer(client),
  teardown: () => client.close()
})
