/**
 * Postgres-flavored authoring namespace `pg` plus the dialect, compiler, and
 * driver (spec §5). `pg.table`, `pg.uuid`, `pg.text`, ... mirror the spec's
 * examples.
 *
 * @module postgres
 */
import { defineTable } from "../schema/table.js"
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  real,
  text,
  timestamp,
  uuid,
  varchar
} from "../schema/index.js"

/** PostgreSQL-flavored schema authoring namespace. */
export const pg = {
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
  jsonb
} as const

export { PostgresDialect, type Dialect } from "./dialect.js"
export { compile } from "./compiler.js"
export { makePostgresDriver, PostgresDriverRuntime, PostgresLayer, type PgClient } from "./driver.js"
export {
  makePostgresJsDriver,
  PostgresJsDriverRuntime,
  PostgresJsLayer,
  type PostgresJsClient,
  type PostgresJsPending,
  type PostgresJsResult
} from "./postgres-js.js"
export { mapDriverError } from "./errors.js"
export { PostgresCapabilities } from "../capabilities/postgres.js"
