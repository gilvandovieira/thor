/**
 * MySQL schema authoring, dialect, migrations, and driver exports.
 *
 * @module mysql
 */
import { Schema } from "effect"
import { makeColumn } from "../schema/column.js"
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  real,
  text,
  timestamp,
  uuid,
  varchar
} from "../schema/index.js"
import { defineTable } from "../schema/table.js"

/**
 * @param name - SQL column name.
 * @param schema - Optional JSON decoder.
 * @returns A nullable MySQL JSON column.
 */
const json = <N extends string, A = unknown>(name: N, schema?: Schema.Schema<A, any>) =>
  makeColumn<N, A>(name, "json", schema ?? Schema.Unknown)

/** MySQL-flavored schema authoring namespace. */
export const mysql = {
  table: defineTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  real,
  doublePrecision,
  boolean,
  timestamp,
  date,
  json
} as const

export { MySQLCapabilities } from "../capabilities/mysql.js"
export { MySQLDialect } from "./dialect.js"
export { compileMySQLOperation, MySQLMigrations } from "./migrations.js"
export {
  makeMySQLDriver,
  mapMySQLDriverError,
  MySQLDriverRuntime,
  MySQLLayer,
  type MySQLClient,
  type MySQLQueryResult,
  type MySQLResult,
  type MySQLResultHeader
} from "./driver.js"
