/**
 * MySQL dialect contract suite (spec §2A.1, §14.11, §18.6).
 *
 * Runs the identical shared contract suite against a real MySQL over a single
 * `mysql2/promise` connection. MySQL does not support DML `RETURNING`, so the
 * capability-gated cases assert a `CapabilityError` before the driver — proving
 * the suite is capability-aware rather than Postgres-shaped.
 *
 * Skipped unless MYSQL_URL is set. See `pnpm e2e`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import mysql2 from "mysql2/promise"
import { MySQLDialect, MySQLLayer, type MySQLClient } from "@gilvandovieira/thor/mysql"
import { type ContractTestApi, makeDialectContractSuite } from "@gilvandovieira/thor/testing"

const MYSQL_URL = process.env.MYSQL_URL

const api: ContractTestApi = { describe, it, beforeAll, afterAll, beforeEach, expect: expect as never }

// MySQL fixture: auto_increment id (omitted by inserts) and a keyable varchar unique.
const MYSQL_RESET = [
  "drop table if exists contract_users",
  "create table contract_users (id int auto_increment primary key, email varchar(255) not null unique, name text, age int)"
]

describe.skipIf(!MYSQL_URL)("mysql contract (e2e)", () => {
  let connection: mysql2.Connection

  makeDialectContractSuite(api, {
    name: "mysql2",
    dialect: MySQLDialect,
    reset: MYSQL_RESET,
    layer: MySQLLayer({
      query: (sql: string, params?: ReadonlyArray<unknown>) => connection.query(sql, params as never),
      execute: (sql: string, params?: ReadonlyArray<unknown>) => connection.execute(sql, params as never)
    } as unknown as MySQLClient),
    setup: async () => {
      connection = await mysql2.createConnection(MYSQL_URL!)
    },
    teardown: () => connection.end()
  })
})
