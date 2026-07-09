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

const version = "2"

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
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled SQLite query data.
   */
  compileQuery: (ir) => compileQuery(ir, SQLiteDialect),
  migrations: SQLiteMigrations
}
