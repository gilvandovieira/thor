/**
 * SQL feature matrix — integration level against real in-memory SQLite
 * (spec §14.11). Proves the generated SQL for every Level 1–2 feature actually
 * parses and runs on the SQLite backend (the fake level covers decode).
 * No Docker; runs in the default test suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { NodeSQLiteLayer, SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { type ContractTestApi, LEVEL_1_2_FEATURES, runSqlFeatureIntegration } from "@gilvandovieira/thor/testing"

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

const client = new DatabaseSync(":memory:")

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: LEVEL_1_2_FEATURES,
  layer: NodeSQLiteLayer(client),
  reset: [
    "drop table if exists users",
    "create table users (id integer primary key, email text not null unique, name text, age integer, created_at text not null default current_timestamp)",
    "insert into users (email, name, age) values ('seed@x.c', 'Seed', 30)"
  ],
  teardown: () => client.close()
})
