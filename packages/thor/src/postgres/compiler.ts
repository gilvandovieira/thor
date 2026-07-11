/**
 * PostgreSQL-compatible query compiler entry point.
 *
 * @module postgres/compiler
 */
import type { Dialect } from "../dialect.js"
import type { CompiledStatement } from "../execution/driver.js"
import type { QueryIR } from "../ir/query-ir.js"
import { compileQuery } from "../sql/compiler.js"
import { PostgresDialect } from "./dialect.js"

/**
 * @param ir - Query IR to compile.
 * @param dialect - Optional compatible dialect; defaults to PostgreSQL.
 * @returns Compiled SQL and parameter metadata.
 */
export const compile = (ir: QueryIR, dialect: Dialect = PostgresDialect): CompiledStatement => compileQuery(ir, dialect)
