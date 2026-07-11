/**
 * Predicate constructors (spec §6.1). Each returns a pure `ExprNode`.
 *
 * @module sql/predicates
 */
import type { AnyColumn } from "../schema/column.js"
import type { ComparisonOp, ExprNode } from "../ir/query-ir.js"
import {
  type ColumnValue,
  type Expr,
  type MergeParameterMaps,
  type Param,
  type ParamsOf,
  type Predicate,
  isColumn,
  literal,
  toExprNode,
  toValueNode
} from "./expressions.js"

/**
 * Constant predicates used to lower degenerate list/logical shapes to valid SQL
 * (spec §8, P0.6). An empty `IN ()` / empty `OR` is unsatisfiable → `FALSE`; an
 * empty `NOT IN ()` / empty `AND` is trivially satisfied → `TRUE`. Lowering at
 * the builder (rather than the compiler) keeps parameter collection consistent:
 * the discarded operands never enter the IR.
 */
const ALWAYS_FALSE: ExprNode = literal(false)
const ALWAYS_TRUE: ExprNode = literal(true)

type Comparable = AnyColumn | Expr<any>
type ComparableValue<T> = T extends AnyColumn ? ColumnValue<T> : T extends Expr<infer A> ? A : unknown
type Value<T extends Comparable> = ComparableValue<T> | Param<string, ComparableValue<T>> | Expr<any> | AnyColumn
type NonParamValue<T extends Comparable> = ComparableValue<T> | Expr<any> | AnyColumn
type Compare = {
  <T extends Comparable, Name extends string, A extends ComparableValue<T>>(
    left: T,
    right: Param<Name, A>
  ): Predicate<{ readonly [K in Name]: A }>
  <T extends Comparable, const R extends NonParamValue<T>>(left: T, right: R): Predicate<ParamsOf<R>>
}

/**
 * @param op - Comparison operator.
 * @param left - Left expression.
 * @param right - Right expression.
 * @returns Runtime comparison representation.
 */
const comparison = <P extends Record<string, unknown>>(
  op: ComparisonOp,
  left: ExprNode,
  right: ExprNode
): Predicate<P> => ({
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
const compare = (op: ComparisonOp) =>
  ((left: Comparable, right: Value<Comparable>): Predicate<any> =>
    comparison(op, toExprNode(left), toValueNode(right, isColumn(left) ? left : undefined))) as Compare

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
export const inArray = <T extends Comparable, V extends ReadonlyArray<Value<T>>>(
  left: T,
  values: V
): Predicate<MergeParameterMaps<ParamsOf<V[number]>>> =>
  (values.length === 0
    ? ALWAYS_FALSE
    : {
        _tag: "InList",
        expr: toExprNode(left),
        values: values.map((v) => toValueNode(v, isColumn(left) ? left : undefined)),
        negated: false
      }) as Predicate<MergeParameterMaps<ParamsOf<V[number]>>>

/**
 * Builds a `NOT IN` expression.
 *
 * @param left - Column whose value is tested.
 * @param values - Typed values, parameters, expressions, or columns.
 * @returns A negated `InList` expression node.
 */
export const notInArray = <T extends Comparable, V extends ReadonlyArray<Value<T>>>(
  left: T,
  values: V
): Predicate<MergeParameterMaps<ParamsOf<V[number]>>> =>
  (values.length === 0
    ? ALWAYS_TRUE
    : {
        _tag: "InList",
        expr: toExprNode(left),
        values: values.map((v) => toValueNode(v, isColumn(left) ? left : undefined)),
        negated: true
      }) as Predicate<MergeParameterMaps<ParamsOf<V[number]>>>

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
export const and = <const T extends ReadonlyArray<ExprNode>>(
  ...operands: T
): Predicate<MergeParameterMaps<ParamsOf<T[number]>>> =>
  (operands.length === 0 ? ALWAYS_TRUE : { _tag: "Logical", op: "and", operands }) as Predicate<
    MergeParameterMaps<ParamsOf<T[number]>>
  >

/**
 * @param operands - Predicates to disjoin.
 * @returns A parenthesized logical `OR` node.
 */
export const or = <const T extends ReadonlyArray<ExprNode>>(
  ...operands: T
): Predicate<MergeParameterMaps<ParamsOf<T[number]>>> =>
  (operands.length === 0 ? ALWAYS_FALSE : { _tag: "Logical", op: "or", operands }) as Predicate<
    MergeParameterMaps<ParamsOf<T[number]>>
  >

/**
 * @param expr - Predicate to negate.
 * @returns A logical `NOT` node.

 */
export const not = <T extends ExprNode>(expr: T): Predicate<ParamsOf<T>> => ({ _tag: "Not", expr })
