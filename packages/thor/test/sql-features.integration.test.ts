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
  LEVEL_1_2_FEATURES,
  ROUTINE_SQL_FEATURES,
  runSqlFeatureIntegration
} from "@gilvandovieira/thor/testing"

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

const client = new DatabaseSync(":memory:")

runSqlFeatureIntegration(api, {
  dialect: SQLiteDialect,
  features: [...LEVEL_1_2_FEATURES, ...ADVANCED_SQL_FEATURES, ...ROUTINE_SQL_FEATURES],
  layer: NodeSQLiteLayer(client),
  reset: [
    "drop table if exists users",
    "create table users (id text primary key default (lower(hex(randomblob(16)))), email text not null unique, name text, age integer, created_at text not null default current_timestamp)",
    "insert into users (id, email, name, age) values ('u1', 'seed@x.c', 'Seed', 30)",
    "drop table if exists posts",
    "create table posts (id text primary key default (lower(hex(randomblob(16)))), user_id text not null, title text not null)",
    "insert into posts (id, user_id, title) values ('p1', 'u1', 'Hello')"
  ],
  teardown: () => client.close()
})
