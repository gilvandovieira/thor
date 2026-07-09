/**
 * Aggregate, subquery, and window-expression constructors.
 *
 * These helpers build pure expression IR. Dialect capability checks still run
 * before execution through the normal query guard pipeline.
 *
 * @module sql/advanced-expressions
 */
import type { AnyColumn } from "../schema/column.js"
import type { FunctionCallNode, OrderByTerm, SelectIR } from "../ir/query-ir.js"
import { type ColumnValue, type Expr, toExprNode } from "./expressions.js"

/** Structural select shape accepted by subquery helpers. */
export interface SelectExpressionSource {
  /** Select IR embedded by the expression. */
  readonly ir: SelectIR
}

/** Values accepted as function and window operands. */
export type ExpressionInput = AnyColumn | Expr<unknown>

/** Window partitioning and ordering specification. */
export interface WindowSpec {
  /** Expressions partitioning the window. */
  readonly partitionBy?: ReadonlyArray<ExpressionInput>
  /** Ordered terms within each partition. */
  readonly orderBy?: ReadonlyArray<OrderByTerm>
  /** Optional trusted SQL frame clause without the `OVER` keyword. */
  readonly frame?: string
}

/** Function expression that can be applied over a window. */
export interface WindowableExpr<A> extends Expr<A> {
  /**
   * @param spec - Partition, ordering, and optional frame definition.
   * @returns A window-function expression.
   */
  readonly over: (spec?: WindowSpec) => Expr<A>
}

/**
 * Wraps a function node with an `.over()` constructor.
 *
 * @typeParam A - Decoded expression type.
 * @param node - Function call representation.
 * @returns Typed function expression with window support.
 */
const windowable = <A>(node: FunctionCallNode): WindowableExpr<A> => ({
  node,
  over: (spec = {}) => ({
    node: {
      _tag: "WindowFunction",
      function: node,
      partitionBy: (spec.partitionBy ?? []).map(toExprNode),
      orderBy: spec.orderBy ?? [],
      ...(spec.frame ? { frame: spec.frame } : {})
    }
  })
})

/**
 * @param name - SQL function name.
 * @param args - Function operands.
 * @returns Aggregate expression with optional window application.
 */
const aggregate = <A>(name: string, args: ReadonlyArray<ExpressionInput>): WindowableExpr<A> =>
  windowable<A>({
    _tag: "FunctionCall",
    name,
    args: args.map(toExprNode),
    aggregate: true,
    star: args.length === 0
  })

/**
 * @param value - Optional counted expression; omit for `count(*)`.
 * @returns A numeric count expression.
 */
export const count = (value?: ExpressionInput): WindowableExpr<number> =>
  aggregate<number>("count", value === undefined ? [] : [value])

/**
 * @param value - Numeric expression to sum.
 * @returns A numeric sum expression.
 */
export const sum = (value: ExpressionInput): WindowableExpr<number> => aggregate<number>("sum", [value])

/**
 * @param value - Numeric expression to average.
 * @returns A numeric average expression.
 */
export const avg = (value: ExpressionInput): WindowableExpr<number> => aggregate<number>("avg", [value])

/**
 * @typeParam A - Expression result type.
 * @param value - Expression whose minimum is requested.
 * @returns A minimum-value expression.
 */
export const min = <A>(value: AnyColumn | Expr<A>): WindowableExpr<A> => aggregate<A>("min", [value])

/**
 * @typeParam A - Expression result type.
 * @param value - Expression whose maximum is requested.
 * @returns A maximum-value expression.
 */
export const max = <A>(value: AnyColumn | Expr<A>): WindowableExpr<A> => aggregate<A>("max", [value])

/** @returns A `row_number()` window function awaiting `.over()`. */
export const rowNumber = (): WindowableExpr<number> =>
  windowable<number>({ _tag: "FunctionCall", name: "row_number", args: [], aggregate: false, star: false })

/** @returns A `rank()` window function awaiting `.over()`. */
export const rank = (): WindowableExpr<number> =>
  windowable<number>({ _tag: "FunctionCall", name: "rank", args: [], aggregate: false, star: false })

/** @returns A `dense_rank()` window function awaiting `.over()`. */
export const denseRank = (): WindowableExpr<number> =>
  windowable<number>({ _tag: "FunctionCall", name: "dense_rank", args: [], aggregate: false, star: false })

/**
 * @typeParam A - Scalar subquery result type.
 * @param query - Query expected to return one selected value.
 * @returns A scalar-subquery expression.
 */
export const scalar = <A = unknown>(query: SelectExpressionSource): Expr<A> => ({
  node: { _tag: "ScalarSubquery", query: query.ir }
})

/**
 * @param query - Query tested for at least one row.
 * @returns An `EXISTS` predicate.
 */
export const exists = (query: SelectExpressionSource) => ({
  _tag: "Exists" as const,
  query: query.ir,
  negated: false
})

/**
 * @param query - Query tested for no rows.
 * @returns A `NOT EXISTS` predicate.
 */
export const notExists = (query: SelectExpressionSource) => ({
  _tag: "Exists" as const,
  query: query.ir,
  negated: true
})

/**
 * @typeParam T - Column value type.
 * @param value - Value compared with the subquery result.
 * @param query - Single-column select query.
 * @returns An `IN (subquery)` predicate.
 */
export const inSubquery = <T extends AnyColumn>(value: T | Expr<ColumnValue<T>>, query: SelectExpressionSource) => ({
  _tag: "InSubquery" as const,
  expr: toExprNode(value),
  query: query.ir,
  negated: false
})

/**
 * @typeParam T - Column value type.
 * @param value - Value compared with the subquery result.
 * @param query - Single-column select query.
 * @returns A `NOT IN (subquery)` predicate.
 */
export const notInSubquery = <T extends AnyColumn>(value: T | Expr<ColumnValue<T>>, query: SelectExpressionSource) => ({
  _tag: "InSubquery" as const,
  expr: toExprNode(value),
  query: query.ir,
  negated: true
})

/**
 * References the candidate row inside an upsert update assignment.
 *
 * @typeParam T - Source column type.
 * @param column - Inserted column to reference.
 * @returns Dialect-rendered excluded/candidate-row expression.
 */
export const excluded = <T extends AnyColumn>(column: T): Expr<ColumnValue<T>> => ({
  node: { _tag: "ExcludedRef", column: column.def.name }
})
