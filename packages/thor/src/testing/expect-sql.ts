/**
 * SQL snapshot helpers (spec §14.8). These return plain, stable data so you can
 * assert with your test runner of choice (`expect(expectSql(q)).toEqual(...)` or
 * `.toMatchSnapshot()`).
 *
 * @module testing/expect-sql
 */
import type { CompiledStatement } from "../execution/driver.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"

/** Anything that can compile itself to SQL (the query builder result types). */
export interface Compilable {
  /**
   * @param dialect - Optional compilation dialect.
   * @returns Compiled SQL and parameter metadata.
   */
  readonly toSql: (dialect?: Dialect) => CompiledStatement
}

/** Stable, serializable view of a compiled query. */
export interface SqlSnapshot {
  readonly sql: string
  readonly params: ReadonlyArray<{ readonly name: string; readonly value?: unknown }>
  readonly cacheKey: string
}

/**
 * @param query - Query builder result supporting `toSql()`.
 * @param dialect - Compilation dialect; defaults to PostgreSQL.
 * @returns Stable SQL, parameter metadata, and cache key.
 */
export const expectSql = (query: Compilable, dialect: Dialect = PostgresDialect): SqlSnapshot => {
  const compiled = query.toSql(dialect)
  return {
    sql: compiled.sql,
    params: compiled.paramOrder.map((p) => ("value" in p ? { name: p.name, value: p.value } : { name: p.name })),
    cacheKey: compiled.cacheKey
  }
}

/**
 * @param query - Query builder result.
 * @param dialect - Compilation dialect.
 * @returns Compiled SQL text only.

 */
export const sqlOf = (query: Compilable, dialect: Dialect = PostgresDialect): string => query.toSql(dialect).sql
