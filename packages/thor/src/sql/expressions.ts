/**
 * Expression helpers: turning columns, params, and literals into IR nodes.
 *
 * @module sql/expressions
 */
import { Schema } from "effect"
import type { AnyColumn, Column } from "../schema/column.js"
import type { ColumnRefNode, ExprNode, LiteralNode, OrderByTerm, ParamNode } from "../ir/query-ir.js"

/** A bound query parameter carrying a phantom runtime type `A`. */
export type Param<A> = ParamNode & { readonly _A?: A }

/** A typed expression wrapper (currently a thin carrier around an IR node). */
export interface Expr<A> {
  readonly node: ExprNode
  readonly _A?: A
}

/** The runtime value type a column reference/comparison expects. */
export type ColumnValue<T> = T extends Column<infer C>
  ? C extends { readonly data: infer D }
    ? C extends { readonly notNull: true }
      ? D
      : D | null
    : unknown
  : never

/**
 * Declares a named, typed query parameter.
 *
 * @typeParam A - Runtime parameter value type.
 * @param name - Name resolved from execution arguments.
 * @param schema - Effect Schema describing the value.
 * @returns A parameter node that remains unbound until execution.
 */
export const param = <A>(name: string, schema: Schema.Schema<A, any>): Param<A> => ({
  _tag: "Param",
  name,
  codec: schema as Schema.Schema<any, any>
})

let anonCounter = 0

/**
 * @param column - Bound schema column.
 * @returns Runtime column-reference node.
 */
export const columnRef = (column: AnyColumn): ColumnRefNode => ({
  _tag: "ColumnRef",
  table: column.def.table,
  column: column.def.name,
  dataType: column.def.dataType
})

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a Thor column.
 */
export const isColumn = (value: unknown): value is AnyColumn =>
  typeof value === "object" && value !== null && "def" in value && "notNull" in value

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a parameter node.
 */
const isParamNode = (value: unknown): value is ParamNode =>
  typeof value === "object" && value !== null && (value as { _tag?: string })._tag === "Param"

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is an expression wrapper.
 */
const isExpr = (value: unknown): value is Expr<unknown> =>
  typeof value === "object" && value !== null && "node" in value

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is runtime expression IR.
 */
const isExprNode = (value: unknown): value is ExprNode =>
  typeof value === "object" && value !== null && "_tag" in value

/**
 * @param value - Column, expression wrapper, parameter, node, or literal.
 * @returns Normalized expression node.
 */
export const toExprNode = (value: unknown): ExprNode => {
  if (isColumn(value)) return columnRef(value)
  if (isParamNode(value)) return value
  if (isExpr(value)) return value.node
  if (isExprNode(value)) return value
  return literal(value as LiteralNode["value"])
}

/**
 * @param value - Trusted primitive value.
 * @returns A literal expression node.
 */
export const literal = (value: LiteralNode["value"]): LiteralNode => ({ _tag: "Literal", value })

/**
 * @param value - Column or expression to sort.
 * @returns Ascending order term.
 */
export const asc = (value: AnyColumn | Expr<unknown>): OrderByTerm => ({ expr: toExprNode(value), direction: "asc" })

/**
 * @param value - Column or expression to sort.
 * @returns Descending order term.
 */
export const desc = (value: AnyColumn | Expr<unknown>): OrderByTerm => ({ expr: toExprNode(value), direction: "desc" })

/**
 * Coerce the right-hand side of a comparison into a node. Raw JS values become
 * anonymous params typed by the left column's codec so user input is always
 * parameterized, never string-interpolated.
 *
 * @param value - Right-hand value, column, parameter, or expression.
 * @param leftColumn - Optional column supplying the parameter codec.
 * @returns Normalized expression node.
 */
export const toValueNode = (value: unknown, leftColumn?: AnyColumn): ExprNode => {
  if (isColumn(value)) return columnRef(value)
  if (isParamNode(value)) return value
  if (isExpr(value)) return value.node
  const codec = leftColumn?.def.codec ?? Schema.Unknown
  return { _tag: "Param", name: `p${++anonCounter}`, codec, value } satisfies ParamNode
}
