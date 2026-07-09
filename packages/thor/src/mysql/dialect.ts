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
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled MySQL query data.
   */
  compileQuery: (ir) => compileQuery(ir, MySQLDialect),
  migrations: MySQLMigrations
}
