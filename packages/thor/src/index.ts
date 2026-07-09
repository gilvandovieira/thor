/**
 * `@gilvandovieira/thor` main entry (spec §2.2).
 *
 *   import { pg, db, sql, eq, and, param } from "@gilvandovieira/thor"
 *
 * Deeper surfaces live under subpaths: `/schema`, `/sql`, `/postgres`, `/sqlite`, `/mysql`,
 * `/migrate`, `/testing`, `/routine`, `/capabilities`.
 *
 * @module thor
 */

// Authoring
export {
  pg,
  PostgresDialect,
  PostgresDriverRuntime,
  PostgresJsDriverRuntime,
  PostgresLayer,
  makePostgresDriver,
  type PgClient
} from "./postgres/index.js"
export {
  BunSQLiteDriverRuntime,
  BunSQLiteLayer,
  makeBunSQLiteDriver,
  makeNodeSQLiteDriver,
  sqlite,
  NodeSQLiteDriverRuntime,
  NodeSQLiteLayer,
  SQLiteDialect,
  SQLiteDriverRuntime,
  SQLiteLayer,
  makeSQLiteDriver,
  type SQLiteClient,
  type SQLiteLayerOptions,
  type SQLiteStatement
} from "./sqlite/index.js"
export {
  mysql,
  MySQLDialect,
  MySQLDriverRuntime,
  MySQLLayer,
  makeMySQLDriver,
  type MySQLClient
} from "./mysql/index.js"
export { db, PreparedQuery } from "./sql/query-builder.js"
export type { Dialect, DialectStatement, MigrationDialect } from "./dialect.js"

// Expressions & predicates
export {
  and,
  or,
  not,
  eq,
  ne,
  lt,
  lte,
  gt,
  gte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull
} from "./sql/predicates.js"
export { param, asc, desc, type Expr, type Param } from "./sql/expressions.js"
export { rawExpr as sql } from "./sql/raw.js"

// Schema types
export {
  type Table,
  type AnyTable,
  type Select,
  type Insert,
  type Update,
  type Column,
  type AnyColumn
} from "./schema/index.js"

// Execution
export { Database, type DatabaseService } from "./execution/database.js"
export { type Driver, type CompiledQuery, type CommandResult, type RawRow } from "./execution/driver.js"
export {
  type ExecutionMode,
  type DecodeMode,
  planKey,
  resolveDecodeMode,
  withMode,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_DECODE_MODE
} from "./execution/plan.js"

// Capabilities & errors
export * as Capabilities from "./capabilities/index.js"
export * from "./errors/index.js"

// IR
export { queryStructuralHash } from "./ir/structural-hash.js"
export { normalizeQuery } from "./ir/normalize.js"
export { collectQueryParams } from "./ir/query-ir.js"
export type {
  QueryIR,
  SelectIR,
  InsertIR,
  UpdateIR,
  DeleteIR,
  ExprNode,
  ParamNode,
  SelectionField,
  QueryAnnotations,
  Cardinality
} from "./ir/index.js"
