/**
 * Query expressions, predicates, builders, and raw SQL escape hatches.
 *
 * @module sql
 */
export * from "./expressions.js"
export * from "./advanced-expressions.js"
export * from "./predicates.js"
export * from "./query-builder.js"
export { rawExpr, unsafeSql, type RawInterpolation } from "./raw.js"
export type {
  CompiledQuery,
  CompiledCardinality,
  CompilableEffect,
  CompilableTerminal,
  TerminalResult
} from "../execution/compiled-query.js"
