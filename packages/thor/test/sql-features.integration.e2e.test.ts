/**
 * SQL feature matrix — integration level against real Postgres and MySQL
 * (spec §14.11, §18.6). Proves every Level 1–2 feature's generated SQL parses
 * and runs on each backend; MySQL's unsupported `RETURNING` features assert
 * `CapabilityError`. Skipped unless DATABASE_URL / MYSQL_URL are set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import pg from "pg"
import mysql2 from "mysql2/promise"
import { PostgresDialect, PostgresLayer } from "@gilvandovieira/thor/postgres"
import { MySQLDialect, MySQLLayer, type MySQLClient } from "@gilvandovieira/thor/mysql"
import {
  ADVANCED_SQL_FEATURES,
  type ContractTestApi,
  LEVEL_1_2_FEATURES,
  runSqlFeatureIntegration
} from "@gilvandovieira/thor/testing"

const DATABASE_URL = process.env.DATABASE_URL
const MYSQL_URL = process.env.MYSQL_URL
const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

const PG_RESET = [
  "drop table if exists users",
  "create table users (id uuid primary key default gen_random_uuid(), email text not null unique, name text, age integer, created_at timestamptz not null default now())",
  "insert into users (email, name, age) values ('seed@x.c', 'Seed', 30)",
  "drop table if exists posts",
  "create table posts (id uuid primary key default gen_random_uuid(), user_id uuid not null, title text not null)",
  "insert into posts (user_id, title) select id, 'Hello' from users limit 1"
]
const MYSQL_RESET = [
  "drop table if exists users",
  "create table users (id varchar(36) primary key default (uuid()), email varchar(255) not null unique, name text, age int, created_at timestamp not null default current_timestamp)",
  "insert into users (id, email, name, age) values ('u1', 'seed@x.c', 'Seed', 30)",
  "drop table if exists posts",
  "create table posts (id varchar(36) primary key default (uuid()), user_id varchar(36) not null, title text not null)",
  "insert into posts (id, user_id, title) values ('p1', 'u1', 'Hello')"
]

describe.skipIf(!DATABASE_URL)("feature integration: postgres (e2e)", () => {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  runSqlFeatureIntegration(api, {
    dialect: PostgresDialect,
    features: [...LEVEL_1_2_FEATURES, ...ADVANCED_SQL_FEATURES],
    layer: PostgresLayer(client),
    reset: PG_RESET,
    setup: async () => {
      await client.connect()
    },
    teardown: () => client.end()
  })
})

describe.skipIf(!MYSQL_URL)("feature integration: mysql (e2e)", () => {
  let connection: mysql2.Connection
  runSqlFeatureIntegration(api, {
    dialect: MySQLDialect,
    features: [...LEVEL_1_2_FEATURES, ...ADVANCED_SQL_FEATURES],
    layer: MySQLLayer({
      query: (sql: string, params?: ReadonlyArray<unknown>) => connection.query(sql, params as never),
      execute: (sql: string, params?: ReadonlyArray<unknown>) => connection.execute(sql, params as never)
    } as unknown as MySQLClient),
    reset: MYSQL_RESET,
    setup: async () => {
      connection = await mysql2.createConnection(MYSQL_URL!)
    },
    teardown: () => connection.end()
  })
})
