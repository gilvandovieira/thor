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
  PostgresPoolLayer,
  PostgresScopedLayer,
  makePostgresDriver,
  type PgClient,
  type PgClientResource,
  type PgPool,
  type PgPoolClient
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
  SQLiteScopedLayer,
  makeSQLiteDriver,
  type SQLiteClient,
  type SQLiteClientResource,
  type SQLiteLayerOptions,
  type SQLiteStatement
} from "./sqlite/index.js"
export {
  mysql,
  MySQLDialect,
  MySQLDriverRuntime,
  MySQLLayer,
  MySQLPoolLayer,
  MySQLScopedLayer,
  makeMySQLDriver,
  type MySQLClient,
  type MySQLClientResource,
  type MySQLPool,
  type MySQLPoolConnection
} from "./mysql/index.js"
export { db, PreparedQuery, QueryReference } from "./sql/query-builder.js"
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
export {
  avg,
  count,
  denseRank,
  excluded,
  exists,
  inSubquery,
  max,
  min,
  notExists,
  notInSubquery,
  rank,
  rowNumber,
  scalar,
  sum,
  type ExpressionInput,
  type SelectExpressionSource,
  type WindowSpec,
  type WindowableExpr
} from "./sql/advanced-expressions.js"
export { rawExpr as sql, unsafeSql } from "./sql/raw.js"

// Schema types
export {
  alias,
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
export { type Driver, type CompiledStatement, type CommandResult, type RawRow } from "./execution/driver.js"
export type {
  CompiledQuery,
  CompiledCardinality,
  CompilableEffect,
  CompilableTerminal,
  TerminalResult
} from "./execution/compiled-query.js"
export {
  transaction,
  type TransactionIsolationLevel,
  type TransactionOptions,
  type TransactionRetryPolicy
} from "./execution/transaction.js"
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
export { collectQueryParams, queryCapabilityBits } from "./ir/query-ir.js"
export type {
  QueryIR,
  SelectIR,
  InsertIR,
  UpdateIR,
  DeleteIR,
  CallIR,
  ExprNode,
  ParamNode,
  SelectionField,
  QuerySource,
  SubquerySource,
  CteSource,
  TableFunctionSource,
  JoinTerm,
  JoinType,
  CommonTableExpression,
  SetOperation,
  InsertConflict,
  QueryAnnotations,
  Cardinality
} from "./ir/index.js"
