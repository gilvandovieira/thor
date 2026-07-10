/**
 * MySQL query syntax, capabilities, and migration behavior.
 *
 * @module mysql/dialect
 */
import { MySQLCapabilities } from "../capabilities/mysql.js"
import type { Dialect } from "../dialect.js"
import { compileQuery } from "../sql/compiler.js"
import { MySQLMigrations } from "./migrations.js"
import { dialectProfileHash } from "../capabilities/profile.js"

const version = "3"
/** @param level - Public isolation level. @returns MySQL SQL spelling. */
const isolationSql = (level: string): string => level.replace(/-/g, " ").toUpperCase()

/** Complete MySQL dialect consumed by builders, execution, and migrations. */
export const MySQLDialect: Dialect = {
  id: "mysql",
  version,
  capabilities: MySQLCapabilities,
  profileHash: dialectProfileHash("mysql", version, MySQLCapabilities),
  /**
   * @param name - Untrusted SQL identifier.
   * @returns Backtick-quoted MySQL identifier.
   */
  quoteIdent: (name) => `\`${name.replace(/`/g, "``")}\``,
  /**
   * @param _index - One-based bind position, unused by MySQL.
   * @returns The MySQL positional placeholder.
   */
  placeholder: () => "?",
  /**
   * @param left - Compiled left expression.
   * @param operator - Logical comparison operator.
   * @param right - Compiled right expression.
   * @returns MySQL comparison SQL.
   */
  comparison: (left, operator, right) =>
    operator === "ilike"
      ? `LOWER(${left}) LIKE LOWER(${right})`
      : `${left} ${operator === "like" ? "LIKE" : operator} ${right}`,
  /** @param column - Candidate-row column. @returns MySQL inserted-row syntax. */
  excluded: (column) => `VALUES(${MySQLDialect.quoteIdent(column)})`,
  /** @param expression - Argument SQL. @param _dataType - Declared type. @returns Unchanged MySQL argument. */
  routineArgument: (expression) => expression,
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled MySQL query data.
   */
  compileQuery: (ir) => compileQuery(ir, MySQLDialect),
  transactions: {
    /** @param options - Transaction options. @returns Ordered MySQL start statements. */
    begin: (options) => {
      const statements: Array<{ readonly sql: string; readonly phase: string }> = []
      if (options.isolationLevel) {
        statements.push({ sql: `set transaction isolation level ${isolationSql(options.isolationLevel)}`, phase: "set isolation" })
      }
      const mode = options.accessMode ? ` ${options.accessMode.replace("-", " ")}` : ""
      statements.push({ sql: `start transaction${mode}`, phase: "begin" })
      return statements
    }
  },
  migrations: MySQLMigrations
}
