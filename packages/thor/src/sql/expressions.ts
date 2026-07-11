/**
 * Expression helpers: turning columns, params, and literals into IR nodes.
 *
 * @module sql/expressions
 */
import { Schema } from "effect"
import { type AnyColumn, Column, columnParamCodec } from "../schema/column.js"
import {
  snapshotInlineValue,
  type ColumnRefNode,
  type ExprNode,
  type LiteralNode,
  type OrderByTerm,
  type ParamNode
} from "../ir/query-ir.js"

declare const ParamType: unique symbol

/**
 * Brand carried by every Thor-constructed expression wrapper and parameter
 * node. Value positions only treat an object as SQL-bearing when this symbol
 * is present, so plain application data — including hostile JSON that
 * structurally imitates a node (`{ node: … }`, `{ _tag: "Param" }`) — is always
 * bound as an encoded parameter instead of becoming SQL syntax. `Symbol.for`
 * keeps the brand stable when two copies of the package coexist.
 *
 * @internal
 */
export const SqlInputBrand: unique symbol = Symbol.for("@gilvandovieira/thor/sql-input")

/** A bound query parameter carrying its literal name and phantom runtime type. */
export type Param<Name extends string, A> = ParamNode & {
  readonly name: Name
  readonly [ParamType]: readonly [Name, A]
}

/** Phantom named-parameter map carried by typed predicate nodes. */
export type ParamsOf<T> = T extends { readonly [ParamType]: readonly [infer Name extends string, infer A] }
  ? { readonly [K in Name]: A }
  : T extends { readonly _Params?: infer P }
    ? P extends Record<string, unknown>
      ? P
      : {}
    : {}

/** Runtime expression node carrying its named-parameter requirements. */
export type Predicate<P extends Record<string, unknown> = {}> = ExprNode & { readonly _Params?: P }

/** Converts a union of parameter maps to their combined intersection. */
export type MergeParameterMaps<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I extends Record<string, unknown>
    ? I
    : {}
  : {}

/** A typed expression wrapper (currently a thin carrier around an IR node). */
export interface Expr<A> {
  readonly node: ExprNode
  /** Optional decoder used when the expression is selected. */
  readonly codec?: Schema.Schema<A, any>
  readonly _A?: A
  /** Runtime brand distinguishing constructed wrappers from look-alike data. */
  readonly [SqlInputBrand]?: true
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
export const param = <const Name extends string, S extends Schema.Schema.AnyNoContext>(
  name: Name,
  schema: S
): Param<Name, Schema.Schema.Type<S>> =>
  ({
    _tag: "Param",
    name,
    codec: schema as Schema.Schema<any, any>,
    [SqlInputBrand]: true
  }) as unknown as Param<Name, Schema.Schema.Type<S>>

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
 * @returns Whether `value` is a Thor column (a class instance, never a structural look-alike).
 */
export const isColumn = (value: unknown): value is AnyColumn => value instanceof Column

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a parameter node produced by `param(...)` (brand required).
 */
export const isParamNode = (value: unknown): value is ParamNode =>
  typeof value === "object" && value !== null && (value as { _tag?: string })._tag === "Param" && SqlInputBrand in value

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is an expression wrapper produced by a Thor constructor (brand required).
 */
export const isExpr = (value: unknown): value is Expr<unknown> =>
  typeof value === "object" && value !== null && "node" in value && SqlInputBrand in value

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` may carry SQL semantics in a value position (column, param, or expression).
 */
export const isSqlInput = (value: unknown): boolean => isColumn(value) || isParamNode(value) || isExpr(value)

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is runtime expression IR.
 */
const isExprNode = (value: unknown): value is ExprNode => typeof value === "object" && value !== null && "_tag" in value

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
  const codec = leftColumn ? columnParamCodec(leftColumn) : Schema.Unknown
  return { _tag: "Param", name: `p${++anonCounter}`, codec, value: snapshotInlineValue(value) } satisfies ParamNode
}

/**
 * Like {@link toValueNode} but binds a raw value through an explicitly supplied
 * codec (e.g. a declared routine argument's codec) so it is validated and
 * encoded like any other parameter (Finding 6). Columns, parameters, and
 * expressions pass through unchanged.
 *
 * @param value - Argument value, column, parameter, or expression.
 * @param codec - Codec applied to raw inline values.
 * @returns Normalized expression node.
 */
export const toValueNodeWithCodec = (value: unknown, codec: Schema.Schema<any, any>): ExprNode => {
  if (isColumn(value)) return columnRef(value)
  if (isParamNode(value)) return value
  if (isExpr(value)) return value.node
  return { _tag: "Param", name: `p${++anonCounter}`, codec, value: snapshotInlineValue(value) } satisfies ParamNode
}
