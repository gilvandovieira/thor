/**
 * Aggregate, subquery, and window-expression constructors.
 *
 * These helpers build pure expression IR. Dialect capability checks still run
 * before execution through the normal query guard pipeline.
 *
 * @module sql/advanced-expressions
 */
import { Schema } from "effect"
import { NumericCodec, SafeIntegerCodec } from "../schema/codecs.js"
import type { AnyColumn } from "../schema/column.js"
import type {
  FunctionCallNode,
  OrderByTerm,
  SelectIR,
  UnsafeSqlNode,
  WindowFrameBoundaryNode,
  WindowFrameNode
} from "../ir/query-ir.js"
import { isUnsafeSqlNode } from "../ir/unsafe-sql.js"
import { type ColumnValue, type Expr, SqlInputBrand, isColumn, toExprNode } from "./expressions.js"

/** Structural select shape accepted by subquery helpers. */
export interface SelectExpressionSource {
  /** Select IR embedded by the expression. */
  readonly ir: SelectIR
}

/** Values accepted as function and window operands. */
export type ExpressionInput = AnyColumn | Expr<any>

/** Window partitioning and ordering specification. */
export interface WindowSpec {
  /** Expressions partitioning the window. */
  readonly partitionBy?: ReadonlyArray<ExpressionInput>
  /** Ordered terms within each partition. */
  readonly orderBy?: ReadonlyArray<OrderByTerm>
  /** Structured frame, or an explicitly unsafe custom SQL fragment. */
  readonly frame?: WindowFrameNode | UnsafeSqlNode
}

/** Beginning of a partition. */
export const unboundedPreceding: WindowFrameBoundaryNode = { _tag: "UnboundedPreceding" }
/** The current result row. */
export const currentRow: WindowFrameBoundaryNode = { _tag: "CurrentRow" }
/** End of a partition. */
export const unboundedFollowing: WindowFrameBoundaryNode = { _tag: "UnboundedFollowing" }

/**
 * @param offset - Finite, non-negative safe-integer row/value offset.
 * @returns A structured preceding frame boundary.
 * @throws {RangeError} When the offset is invalid.
 */
export const preceding = (offset: number): WindowFrameBoundaryNode => {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError(`Window frame offset must be a non-negative safe integer, received ${offset}`)
  return { _tag: "Preceding", offset }
}

/**
 * @param offset - Finite, non-negative safe-integer row/value offset.
 * @returns A structured following frame boundary.
 * @throws {RangeError} When the offset is invalid.
 */
export const following = (offset: number): WindowFrameBoundaryNode => {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError(`Window frame offset must be a non-negative safe integer, received ${offset}`)
  return { _tag: "Following", offset }
}

/** @param boundary - Frame boundary. @returns Its monotonic ordering rank. */
const boundaryRank = (boundary: WindowFrameBoundaryNode): number => {
  switch (boundary._tag) {
    case "UnboundedPreceding":
      return Number.NEGATIVE_INFINITY
    case "Preceding":
      return -boundary.offset
    case "CurrentRow":
      return 0
    case "Following":
      return boundary.offset
    case "UnboundedFollowing":
      return Number.POSITIVE_INFINITY
  }
}

/**
 * @param unit - Window frame unit.
 * @param start - Inclusive starting boundary.
 * @param end - Inclusive ending boundary.
 * @returns A validated structured frame.
 * @throws {RangeError} When the end precedes the start.
 */
const frameBetween = (
  unit: WindowFrameNode["unit"],
  start: WindowFrameBoundaryNode,
  end: WindowFrameBoundaryNode
): WindowFrameNode => {
  if (!isValidBoundary(start) || !isValidBoundary(end)) {
    throw new TypeError("Window frame boundaries must be valid structured boundary values")
  }
  if (boundaryRank(start) > boundaryRank(end)) throw new RangeError("Window frame end cannot precede its start")
  return { _tag: "WindowFrame", unit, start, end }
}

/** @param start - Start boundary. @param end - End boundary. @returns A `ROWS BETWEEN` frame. */
export const rowsBetween = (start: WindowFrameBoundaryNode, end: WindowFrameBoundaryNode): WindowFrameNode =>
  frameBetween("rows", start, end)

/** @param start - Start boundary. @param end - End boundary. @returns A `RANGE BETWEEN` frame. */
export const rangeBetween = (start: WindowFrameBoundaryNode, end: WindowFrameBoundaryNode): WindowFrameNode =>
  frameBetween("range", start, end)

/** @param start - Start boundary. @param end - End boundary. @returns A `GROUPS BETWEEN` frame. */
export const groupsBetween = (start: WindowFrameBoundaryNode, end: WindowFrameBoundaryNode): WindowFrameNode =>
  frameBetween("groups", start, end)

/** Function expression that can be applied over a window. */
export interface WindowableExpr<A> extends Expr<A> {
  /**
   * @param spec - Partition, ordering, and optional frame definition.
   * @returns A window-function expression.
   */
  readonly over: (spec?: WindowSpec) => Expr<A>
}

/**
 * Wraps a function node with an `.over()` constructor, making it usable as a
 * window function. Exported so declared routine functions (Epic R2) share the
 * same windowing path as built-in aggregates.
 *
 * @typeParam A - Decoded expression type.
 * @param node - Function call representation.
 * @param codec - Selected-value decoder.
 * @returns Typed function expression with window support.
 */
export const windowable = <A>(node: FunctionCallNode, codec: Schema.Schema<A, any>): WindowableExpr<A> => ({
  node,
  codec,
  [SqlInputBrand]: true,
  over: (spec = {}) => ({
    node: {
      _tag: "WindowFunction",
      function: node,
      partitionBy: (spec.partitionBy ?? []).map(toExprNode),
      orderBy: spec.orderBy ?? [],
      ...(spec.frame ? { frame: assertWindowFrame(spec.frame) } : {})
    },
    codec,
    [SqlInputBrand]: true
  })
})

const FRAME_UNITS: ReadonlySet<string> = new Set(["rows", "range", "groups"])

/** @param boundary - Candidate boundary node. @returns Whether it is structurally valid. */
const isValidBoundary = (boundary: WindowFrameBoundaryNode): boolean => {
  switch (boundary?._tag) {
    case "UnboundedPreceding":
    case "CurrentRow":
    case "UnboundedFollowing":
      return true
    case "Preceding":
    case "Following":
      return Number.isSafeInteger(boundary.offset) && boundary.offset >= 0
    default:
      return false
  }
}

/**
 * Runtime-validates a window frame so forged or cast frame objects can never
 * interpolate arbitrary text into `OVER (...)`. Structured frames must use the
 * exact constructor vocabulary; custom syntax must be an `unsafeSql` node.
 *
 * @param frame - Structured frame or explicitly unsafe custom fragment.
 * @returns The validated frame.
 * @throws {TypeError} When the frame is not a valid structured or unsafe node.
 */
const assertWindowFrame = (frame: WindowFrameNode | UnsafeSqlNode): WindowFrameNode | UnsafeSqlNode => {
  if (isUnsafeSqlNode(frame)) return frame
  if (
    frame &&
    frame._tag === "WindowFrame" &&
    FRAME_UNITS.has(frame.unit) &&
    isValidBoundary(frame.start) &&
    isValidBoundary(frame.end)
  ) {
    if (boundaryRank(frame.start) > boundaryRank(frame.end)) {
      throw new RangeError("Window frame end cannot precede its start")
    }
    return frame
  }
  throw new TypeError("Window frame must come from rowsBetween/rangeBetween/groupsBetween or be explicit unsafeSql")
}

/**
 * @param name - SQL function name.
 * @param args - Function operands.
 * @param codec - Decoder used when the aggregate is selected.
 * @returns Aggregate expression with optional window application.
 */
const aggregate = <A>(
  name: string,
  args: ReadonlyArray<ExpressionInput>,
  codec: Schema.Schema<A, any>
): WindowableExpr<A> =>
  windowable<A>(
    {
      _tag: "FunctionCall",
      name,
      args: args.map(toExprNode),
      aggregate: true,
      star: args.length === 0,
      declared: false,
      volatility: "immutable",
      capabilities: 0n
    },
    codec
  )

/**
 * @param value - Optional counted expression; omit for `count(*)`.
 * @returns A numeric count expression.
 */
export const count = (value?: ExpressionInput): WindowableExpr<number> =>
  aggregate<number>("count", value === undefined ? [] : [value], SafeIntegerCodec)

/**
 * @param value - Numeric expression to sum.
 * @returns A numeric sum expression.
 */
export const sum = (value: ExpressionInput): WindowableExpr<number> => aggregate<number>("sum", [value], NumericCodec)

/**
 * @param value - Numeric expression to average.
 * @returns A numeric average expression.
 */
export const avg = (value: ExpressionInput): WindowableExpr<number> => aggregate<number>("avg", [value], NumericCodec)

/**
 * @typeParam A - Expression result type.
 * @param value - Expression whose minimum is requested.
 * @returns A minimum-value expression.
 */
export const min = <A>(value: AnyColumn | Expr<A>): WindowableExpr<A> =>
  aggregate<A>(
    "min",
    [value],
    (isColumn(value) ? value.def.codec : (value.codec ?? Schema.Unknown)) as Schema.Schema<A, any>
  )

/**
 * @typeParam A - Expression result type.
 * @param value - Expression whose maximum is requested.
 * @returns A maximum-value expression.
 */
export const max = <A>(value: AnyColumn | Expr<A>): WindowableExpr<A> =>
  aggregate<A>(
    "max",
    [value],
    (isColumn(value) ? value.def.codec : (value.codec ?? Schema.Unknown)) as Schema.Schema<A, any>
  )

/** @returns A `row_number()` window function awaiting `.over()`. */
export const rowNumber = (): WindowableExpr<number> =>
  windowable<number>(
    {
      _tag: "FunctionCall",
      name: "row_number",
      args: [],
      aggregate: false,
      star: false,
      declared: false,
      volatility: "immutable",
      capabilities: 0n
    },
    SafeIntegerCodec
  )

/** @returns A `rank()` window function awaiting `.over()`. */
export const rank = (): WindowableExpr<number> =>
  windowable<number>(
    {
      _tag: "FunctionCall",
      name: "rank",
      args: [],
      aggregate: false,
      star: false,
      declared: false,
      volatility: "immutable",
      capabilities: 0n
    },
    SafeIntegerCodec
  )

/** @returns A `dense_rank()` window function awaiting `.over()`. */
export const denseRank = (): WindowableExpr<number> =>
  windowable<number>(
    {
      _tag: "FunctionCall",
      name: "dense_rank",
      args: [],
      aggregate: false,
      star: false,
      declared: false,
      volatility: "immutable",
      capabilities: 0n
    },
    SafeIntegerCodec
  )

/**
 * @typeParam A - Scalar subquery result type.
 * @param query - Query expected to return one selected value.
 * @returns A scalar-subquery expression.
 */
export const scalar = <A = unknown>(query: SelectExpressionSource): Expr<A> => ({
  node: { _tag: "ScalarSubquery", query: query.ir },
  [SqlInputBrand]: true
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
  node: { _tag: "ExcludedRef", column: column.def.name },
  [SqlInputBrand]: true
})
