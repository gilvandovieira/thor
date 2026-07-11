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
import { validateIdentifier } from "../ir/identifiers.js"

const version = "3"
/** @param level - Public isolation level. @returns PostgreSQL SQL spelling. */
const isolationSql = (level: string): string => level.replace(/-/g, " ").toUpperCase()

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
  quoteIdent: (name) => `"${validateIdentifier(name).replace(/"/g, '""')}"`,
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
  /** @param column - Candidate-row column. @returns PostgreSQL excluded-row syntax. */
  excluded: (column) => `EXCLUDED.${PostgresDialect.quoteIdent(column)}`,
  /** @param expression - Argument SQL. @param dataType - Declared type. @returns Explicitly typed PostgreSQL argument. */
  routineArgument: (expression, dataType) => `${expression}::${dataType}`,
  /**
   * @param ir - Runtime query representation.
   * @returns Compiled PostgreSQL query data.
   */
  compileQuery: (ir) => compileQuery(ir, PostgresDialect),
  transactions: {
    /** @param options - Transaction options. @returns PostgreSQL begin statement. */
    begin: (options) => {
      const clauses = [
        options.isolationLevel ? `isolation level ${isolationSql(options.isolationLevel)}` : undefined,
        options.accessMode?.replace("-", " ")
      ].filter((value): value is string => value !== undefined)
      return [{ sql: clauses.length > 0 ? `begin ${clauses.join(" ")}` : "begin", phase: "begin" }]
    }
  },
  migrations: PostgresMigrations
}

export type { Dialect } from "../dialect.js"
