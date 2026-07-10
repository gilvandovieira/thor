/**
 * SQLite query syntax, capabilities, and migration behavior.
 *
 * @module sqlite/dialect
 */
import { SQLiteCapabilities } from "../capabilities/sqlite.js"
import type { Dialect } from "../dialect.js"
import { compileQuery } from "../sql/compiler.js"
import { SQLiteMigrations } from "./migrations.js"
import { dialectProfileHash } from "../capabilities/profile.js"
import { TransactionError } from "../errors/index.js"

const version = "3"

/** Complete SQLite dialect consumed by builders, execution, and migrations. */
export const SQLiteDialect: Dialect = {
  id: "sqlite",
  version,
  capabilities: SQLiteCapabilities,
  profileHash: dialectProfileHash("sqlite", version, SQLiteCapabilities),
  /**
   * @param name - Untrusted SQL identifier.
   * @returns Double-quoted SQLite identifier.
   */
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  /**
   * @param _index - One-based bind position, unused by SQLite.
   * @returns The SQLite positional placeholder.
   */
  placeholder: () => "?",
  /**
   * @param left - Compiled left expression.
   * @param operator - Logical comparison operator.
   * @param right - Compiled right expression.
   * @returns SQLite comparison SQL.
   */
  comparison: (left, operator, right) =>
    operator === "ilike"
      ? `${left} LIKE ${right} COLLATE NOCASE`
      : `${left} ${operator === "like" ? "LIKE" : operator} ${right}`,
  /** @param column - Candidate-row column. @returns SQLite excluded-row syntax. */
  excluded: (column) => `EXCLUDED.${SQLiteDialect.quoteIdent(column)}`,
  /** @param expression - Argument SQL. @param _dataType - Declared type. @returns Unchanged SQLite argument. */
  routineArgument: (expression) => expression,
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled SQLite query data.
   */
  compileQuery: (ir) => compileQuery(ir, SQLiteDialect),
  transactions: {
    /**
     * @param options - Transaction options.
     * @returns SQLite begin statement.
     * @throws {TransactionError} When SQLite cannot honor an option.
     */
    begin: (options) => {
      if (options.accessMode === "read-only") {
        throw new TransactionError({ message: "SQLite does not enforce read-only transactions" })
      }
      if (
        options.isolationLevel &&
        options.isolationLevel !== "serializable" &&
        options.isolationLevel !== "read-uncommitted"
      ) {
        throw new TransactionError({ message: `SQLite does not support ${options.isolationLevel} isolation` })
      }
      return [{
        sql: options.beginMode ? `begin ${options.beginMode}` : (SQLiteMigrations.beginTransaction ?? "begin"),
        phase: "begin"
      }]
    }
  },
  migrations: SQLiteMigrations
}
