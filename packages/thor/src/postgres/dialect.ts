/**
 * PostgreSQL query syntax, capabilities, and migration behavior.
 *
 * @module postgres/dialect
 */
import type { Dialect } from "../dialect.js"
import { PostgresCapabilities } from "../capabilities/postgres.js"
import { compileQuery } from "../sql/compiler.js"
import { PostgresMigrations } from "./migrations.js"
import { dialectProfileHash } from "../capabilities/profile.js"

const version = "3"

/** Complete PostgreSQL dialect consumed by builders, execution, and migrations. */
export const PostgresDialect: Dialect = {
  id: "postgres",
  version,
  capabilities: PostgresCapabilities,
  profileHash: dialectProfileHash("postgres", version, PostgresCapabilities),
  /**
   * @param name - Untrusted SQL identifier.
   * @returns Double-quoted PostgreSQL identifier.
   */
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  /**
   * @param index - One-based bind position.
   * @returns PostgreSQL's numbered placeholder syntax.
   */
  placeholder: (index) => `$${index}`,
  /**
   * @param left - Compiled left expression.
   * @param operator - Logical comparison operator.
   * @param right - Compiled right expression.
   * @returns PostgreSQL comparison SQL.
   */
  comparison: (left, operator, right) =>
    `${left} ${operator === "like" ? "LIKE" : operator === "ilike" ? "ILIKE" : operator} ${right}`,
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled PostgreSQL query data.
   */
  compileQuery: (ir) => compileQuery(ir, PostgresDialect),
  migrations: PostgresMigrations
}

export type { Dialect } from "../dialect.js"
