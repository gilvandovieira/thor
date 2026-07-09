/**
 * Defines the backend-dialect contract used by query execution and migrations.
 *
 * A dialect owns SQL rendering and backend capabilities, while a driver owns
 * transport to a concrete client library. Keeping these contracts separate lets
 * one dialect support several clients and lets the execution pipeline remain
 * backend-independent.
 *
 * @module dialect
 */
import type { CapabilityMatrix, DialectId } from "./capabilities/matrix.js"
import type { CompiledQuery } from "./execution/driver.js"
import type { QueryIR } from "./ir/query-ir.js"
import type { ComparisonOp } from "./ir/query-ir.js"
import type { MigrationOperation } from "./migrate/migration-ir.js"

/** A SQL statement used by dialect-specific migration lifecycle hooks. */
export interface DialectStatement {
  /** SQL text to execute. */
  readonly sql: string
  /** Positional values to bind to the statement. */
  readonly params?: ReadonlyArray<unknown>
  /**
   * Validates rows returned by statements such as advisory-lock acquisition.
   *
   * @param rows - Raw rows returned by the driver.
   * @returns `true` when the statement achieved its required effect.
   */
  readonly resultCheck?: (rows: ReadonlyArray<Record<string, unknown>>) => boolean
  /** Error message used when `resultCheck` returns `false`. */
  readonly failureMessage?: string
}

/** Backend-specific SQL and lifecycle operations required by the migrator. */
export interface MigrationDialect {
  /**
   * @param operation - Migration IR operation to render.
   * @returns Executable DDL or SQL.
   */
  readonly compileOperation: (operation: MigrationOperation) => string
  /**
   * @param table - Journal table name.
   * @returns DDL that creates the journal if absent.
   */
  readonly ensureJournal: (table: string) => string
  /**
   * @param table - Journal table name.
   * @returns SQL selecting journal entries in application order.
   */
  readonly readJournal: (table: string) => string
  /**
   * @param table - Journal table name.
   * @returns Parameterized SQL inserting one journal entry.
   */
  readonly insertJournal: (table: string) => string
  /**
   * @param table - Journal table name.
   * @returns Parameterized SQL deleting one journal entry.
   */
  readonly deleteJournal: (table: string) => string
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Lock statement, or `undefined` when unnecessary.
   */
  readonly acquireLock: (key: number) => DialectStatement | undefined
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Unlock statement, or `undefined` when unnecessary.
   */
  readonly releaseLock: (key: number) => DialectStatement | undefined
  /** Whether generated DDL can be rolled back inside a transaction. */
  readonly transactionalDdl: boolean
  /** SQL that begins a transaction, or `undefined` when transactions are unavailable. */
  readonly beginTransaction: string | undefined
  /** SQL that commits a transaction, or `undefined` when transactions are unavailable. */
  readonly commitTransaction: string | undefined
  /** SQL that rolls back a transaction, or `undefined` when transactions are unavailable. */
  readonly rollbackTransaction: string | undefined
  /** SQL returning live table names in a `table_name` column. */
  readonly listTables: string
}

/** Complete query and migration behavior for one database backend. */
export interface Dialect {
  /** Stable dialect identifier used in errors and compiled-query cache keys. */
  readonly id: DialectId
  /** Version of this dialect's SQL rendering contract. */
  readonly version: string
  /** Capability support advertised by the backend. */
  readonly capabilities: CapabilityMatrix
  /** Stable hash combining dialect version and capability support. */
  readonly profileHash: string
  /**
   * @param name - Untrusted identifier.
   * @returns Safely quoted backend identifier.
   */
  readonly quoteIdent: (name: string) => string
  /**
   * @param index - One-based bind position.
   * @returns Backend placeholder syntax.
   */
  readonly placeholder: (index: number) => string
  /**
   * @param left - Compiled left operand.
   * @param operator - Logical comparison operator.
   * @param right - Compiled right operand.
   * @returns Backend-specific comparison SQL.
   */
  readonly comparison: (left: string, operator: ComparisonOp, right: string) => string
  /**
   * @param ir - Runtime query representation.
   * @returns SQL, parameter order, and structural cache key.
   */
  readonly compileQuery: (ir: QueryIR) => CompiledQuery
  /** Migration compiler and lifecycle behavior for this backend. */
  readonly migrations: MigrationDialect
}
