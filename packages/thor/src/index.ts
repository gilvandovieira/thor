/**
 * `@gilvandovieira/thor` main entry (spec §2.2).
 *
 *   import { pg, db, sql, eq, and, param } from "@gilvandovieira/thor"
 *
 * Deeper surfaces live under subpaths: `/schema`, `/sql`, `/postgres`, `/sqlite`, `/mysql`,
 * `/migrate`, `/testing`, `/routine`, `/relations`, `/capabilities`, `/observability`,
 * `/introspect`, and `/skills`.
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
  PostgresDedicatedPoolConnectionLayer,
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
  makeRuntimeSQLiteDriver,
  sqlite,
  NodeSQLiteDriverRuntime,
  NodeSQLiteLayer,
  RuntimeSQLiteLayer,
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
  MySQLDedicatedPoolConnectionLayer,
  MySQLScopedLayer,
  makeMySQLDriver,
  type MySQLClient,
  type MySQLClientResource,
  type MySQLPool,
  type MySQLPoolConnection
} from "./mysql/index.js"
export { db, PreparedQuery, QueryReference } from "./sql/query-builder.js"
export {
  defineRelations,
  many,
  one,
  relation,
  withRelations,
  RelationalDatabase,
  RelationalQuery,
  type AnyRelation,
  type ManualRelationContext,
  type RelationDefinitions,
  type RelationDescriptor,
  type RelationKind,
  type RelationLoad,
  type Relations,
  type RelationSelection,
  type RelationStrategy,
  type RelationalRow
} from "./relations/index.js"
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
  currentRow,
  denseRank,
  excluded,
  exists,
  inSubquery,
  max,
  min,
  notExists,
  notInSubquery,
  following,
  groupsBetween,
  preceding,
  rangeBetween,
  rank,
  rowNumber,
  rowsBetween,
  scalar,
  sum,
  unboundedFollowing,
  unboundedPreceding,
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
export type { Driver, CompiledStatement, CommandResult, RawRow } from "./execution/driver.js"
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
  type CanonicalExecutionMode,
  type DecodeMode,
  planKey,
  resolveDecodeMode,
  normalizeMode,
  withMode,
  withQueryCache,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_DECODE_MODE
} from "./execution/plan.js"
export type { QueryCacheOptions, CacheStrategy } from "./execution/cache.js"
export {
  withObservability,
  type LifecycleObservabilityEvent,
  type ObservabilityConfig,
  type ObservabilityContext,
  type ObservabilityEvent,
  type ObservabilityOptions,
  type ObservedParameter,
  type ParameterLoggingMode,
  type QueryCacheOutcome,
  type QueryObservabilityEvent,
  type SqlLoggingMode
} from "./observability/index.js"

// Capabilities & errors
export * as Capabilities from "./capabilities/index.js"
export * from "./errors/index.js"
