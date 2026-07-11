/**
 * Runs the shared dialect contract suite against *multiple real drivers*
 * (spec §14.10): node-postgres and postgres.js, both behind Thor's `Driver`
 * seam, both hitting the same Dockerized Postgres.
 *
 * Skipped unless DATABASE_URL is set. See `pnpm e2e`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import pg from "pg"
import postgres from "postgres"
import { PostgresDialect, PostgresJsLayer, PostgresLayer } from "@gilvandovieira/thor/postgres"
import { type ContractTestApi, makeDialectContractSuite } from "@gilvandovieira/thor/testing"

const DATABASE_URL = process.env.DATABASE_URL

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

// Postgres fixture: schema-per-test reset + a uuid-defaulted id.
const POSTGRES_RESET = [
  "drop schema public cascade",
  "create schema public",
  "create table contract_users (id uuid primary key default gen_random_uuid(), email text not null unique, name text, age integer)"
]

describe.skipIf(!DATABASE_URL)("driver contract suite across drivers (e2e)", () => {
  // node-postgres: a single Client (not a pool) so transactions share a connection.
  const pgClient = new pg.Client({ connectionString: DATABASE_URL })
  makeDialectContractSuite(api, {
    name: "node-postgres",
    dialect: PostgresDialect,
    reset: POSTGRES_RESET,
    layer: PostgresLayer(pgClient),
    setup: async () => {
      await pgClient.connect()
    },
    teardown: () => pgClient.end()
  })

  // postgres.js: max:1 → a single connection, so begin/commit stay on one socket.
  const sql = postgres(DATABASE_URL ?? "postgres://localhost", { max: 1, onnotice: () => {} })
  makeDialectContractSuite(api, {
    name: "postgres.js",
    dialect: PostgresDialect,
    reset: POSTGRES_RESET,
    layer: PostgresJsLayer({ unsafe: (query, params) => sql.unsafe(query, params as never), CLOSE: sql.CLOSE }),
    setup: () => {},
    teardown: () => sql.end({ timeout: 5 })
  })
})
