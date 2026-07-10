/**
 * SQLite schema authoring, dialect, migrations, and driver exports.
 *
 * @module sqlite
 */
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
import { makeColumn } from "../schema/column.js"
import { defineTable } from "../schema/table.js"
import { Schema } from "effect"

/**
 * @param name - SQL column name.
 * @param schema - Optional decoded JSON schema.
 * @returns A nullable JSON text column.
 */
const json = <N extends string, A = unknown>(name: N, schema?: Schema.Schema<A, any>) =>
  makeColumn<N, A>(name, "json", Schema.parseJson(schema ?? Schema.Unknown))

/**
 * SQLite-flavored schema authoring namespace.
 *
 * @stable
 */
export const sqlite = {
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

export { SQLiteCapabilities } from "../capabilities/sqlite.js"
export { SQLiteDialect } from "./dialect.js"
export { compileSQLiteOperation, SQLiteMigrations } from "./migrations.js"
export {
  BunSQLiteDriverRuntime,
  BunSQLiteLayer,
  makeBunSQLiteDriver,
  makeNodeSQLiteDriver,
  makeSQLiteDriver,
  NodeSQLiteDriverRuntime,
  NodeSQLiteLayer,
  SQLiteDriverRuntime,
  SQLiteLayer,
  SQLiteScopedLayer,
  type SQLiteClient,
  type SQLiteClientResource,
  type SQLiteLayerOptions,
  type SQLiteRunResult,
  type SQLiteStatement,
  type SQLiteValue
} from "./driver.js"
