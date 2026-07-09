/**
 * Predicate constructors (spec §6.1). Each returns a pure `ExprNode`.
 *
 * @module sql/predicates
 */
import type { AnyColumn } from "../schema/column.js"
import type { ComparisonOp, ExprNode } from "../ir/query-ir.js"
import { type ColumnValue, type Expr, type Param, isColumn, toExprNode, toValueNode } from "./expressions.js"

type Comparable = AnyColumn | Expr<any>
type ComparableValue<T> = T extends AnyColumn ? ColumnValue<T> : T extends Expr<infer A> ? A : unknown
type Value<T extends Comparable> = ComparableValue<T> | Param<ComparableValue<T>> | Expr<ComparableValue<T>> | AnyColumn

/**
 * @param op - Comparison operator.
 * @param left - Left expression.
 * @param right - Right expression.
 * @returns Runtime comparison representation.
 */
const comparison = (op: ComparisonOp, left: ExprNode, right: ExprNode): ExprNode => ({
  _tag: "Comparison",
  op,
  left,
  right
})

/**
 * Creates a column-aware binary comparison helper.
 *
 * @param op - Comparison operator captured by the returned helper.
 * @returns A typed function that builds comparison IR.
 */
const compare =
  (op: ComparisonOp) =>
  <T extends Comparable>(left: T, right: Value<T>): ExprNode =>
    comparison(op, toExprNode(left), toValueNode(right, isColumn(left) ? left : undefined))

/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns An equality expression.
 */
export const eq = compare("=")
/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns An inequality expression.
 */
export const ne = compare("<>")
/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns A less-than expression.
 */
export const lt = compare("<")
/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns A less-than-or-equal expression.
 */
export const lte = compare("<=")
/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns A greater-than expression.
 */
export const gt = compare(">")
/**
 * @param left - Column on the left.
 * @param right - Typed comparison value.
 * @returns A greater-than-or-equal expression.
 */
export const gte = compare(">=")
/**
 * @param left - Text column.
 * @param right - Pattern value.
 * @returns A dialect-rendered `LIKE` expression.
 */
export const like = compare("like")
/**
 * @param left - Text column.
 * @param right - Pattern value.
 * @returns A dialect-rendered case-insensitive match.
 */
export const ilike = compare("ilike")

/**
 * Builds an `IN` expression.
 *
 * @param left - Column whose value is tested.
 * @param values - Typed values, parameters, expressions, or columns.
 * @returns An `InList` expression node.
 */
export const inArray = <T extends Comparable>(left: T, values: ReadonlyArray<Value<T>>): ExprNode => ({
  _tag: "InList",
  expr: toExprNode(left),
  values: values.map((v) => toValueNode(v, isColumn(left) ? left : undefined)),
  negated: false
})

/**
 * Builds a `NOT IN` expression.
 *
 * @param left - Column whose value is tested.
 * @param values - Typed values, parameters, expressions, or columns.
 * @returns A negated `InList` expression node.
 */
export const notInArray = <T extends Comparable>(left: T, values: ReadonlyArray<Value<T>>): ExprNode => ({
  _tag: "InList",
  expr: toExprNode(left),
  values: values.map((v) => toValueNode(v, isColumn(left) ? left : undefined)),
  negated: true
})

/**
 * @param column - Column to test.
 * @returns An `IS NULL` expression.
 */
export const isNull = (column: Comparable): ExprNode => ({ _tag: "IsNull", expr: toExprNode(column), negated: false })

/**
 * @param column - Column to test.
 * @returns An `IS NOT NULL` expression.
 */
export const isNotNull = (column: Comparable): ExprNode => ({ _tag: "IsNull", expr: toExprNode(column), negated: true })

/**
 * @param operands - Predicates to conjoin.
 * @returns A parenthesized logical `AND` node.
 */
export const and = (...operands: ReadonlyArray<ExprNode>): ExprNode => ({ _tag: "Logical", op: "and", operands })

/**
 * @param operands - Predicates to disjoin.
 * @returns A parenthesized logical `OR` node.
 */
export const or = (...operands: ReadonlyArray<ExprNode>): ExprNode => ({ _tag: "Logical", op: "or", operands })

/**
 * @param expr - Predicate to negate.
 * @returns A logical `NOT` node.

 */
export const not = (expr: ExprNode): ExprNode => ({ _tag: "Not", expr })
