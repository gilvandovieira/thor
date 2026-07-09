/**
 * Runtime Query IR (spec §7.4) — the authoritative representation of a query.
 *
 * The fluent builder produces this pure structure; guards validate it, the
 * compiler lowers it to SQL, and the executor decodes results through the
 * codecs it carries. Everything here is a plain immutable value.
 *
 * @module ir/query-ir
 */
import type { Schema } from "effect"
import type { CapabilityBits } from "../capabilities/capability.js"
import type { PgDataType } from "../schema/column.js"

/** Estimated row count of an operation. */
export type Cardinality = "zero" | "one" | "many"

/** Observability/optimization metadata attached to every node (spec §7.4). */
export interface QueryAnnotations {
  readonly operationName?: string
  readonly tableNames: ReadonlyArray<string>
  readonly estimatedCardinality?: Cardinality
  readonly idempotency?: "idempotent" | "non-idempotent" | "unknown"
  readonly cacheKey?: string
  readonly tracing?: {
    readonly spanName: string
    readonly attributes: Record<string, string | number | boolean>
  }
}

// --- expressions ------------------------------------------------------------

/** Comparison operations supported by the expression IR. */
export type ComparisonOp = "=" | "<>" | "<" | "<=" | ">" | ">=" | "like" | "ilike"

/** Reference to a table-bound column. */
export interface ColumnRefNode {
  readonly _tag: "ColumnRef"
  readonly table: string
  readonly column: string
  readonly dataType: PgDataType
}

/** Named or inline-bound parameter carried through compilation. */
export interface ParamNode {
  readonly _tag: "Param"
  readonly name: string
  readonly codec: Schema.Schema<any, any>
  /**
   * Inline-bound value, present when the param came from a literal in a
   * comparison (e.g. `eq(users.email, "x")`). Named params declared with
   * `param(name, schema)` leave this unset and are resolved from execution args.
   */
  readonly value?: unknown
}

/** SQL-safe literal embedded directly in an expression. */
export interface LiteralNode {
  readonly _tag: "Literal"
  readonly value: string | number | boolean | null
}

/** Binary comparison expression. */
export interface ComparisonNode {
  readonly _tag: "Comparison"
  readonly op: ComparisonOp
  readonly left: ExprNode
  readonly right: ExprNode
}

/** `IN` or `NOT IN` expression. */
export interface InListNode {
  readonly _tag: "InList"
  readonly expr: ExprNode
  readonly values: ReadonlyArray<ExprNode>
  readonly negated: boolean
}

/** Boolean conjunction or disjunction. */
export interface LogicalNode {
  readonly _tag: "Logical"
  readonly op: "and" | "or"
  readonly operands: ReadonlyArray<ExprNode>
}

/** Negated expression. */
export interface NotNode {
  readonly _tag: "Not"
  readonly expr: ExprNode
}

/** `IS NULL` or `IS NOT NULL` expression. */
export interface IsNullNode {
  readonly _tag: "IsNull"
  readonly expr: ExprNode
  readonly negated: boolean
}

/** Trusted raw SQL fragment with separately tracked parameters. */
export interface RawExprNode {
  readonly _tag: "RawExpr"
  readonly sql: string
  readonly params: ReadonlyArray<ParamNode>
}

/** Discriminated union of every runtime expression node. */
export type ExprNode =
  | ColumnRefNode
  | ParamNode
  | LiteralNode
  | ComparisonNode
  | InListNode
  | LogicalNode
  | NotNode
  | IsNullNode
  | RawExprNode

// --- clauses ----------------------------------------------------------------

/** Table source used by statement IR. */
export interface TableSource {
  readonly name: string
  readonly alias?: string
}

/** Selected expression, output alias, and decoder. */
export interface SelectionField {
  readonly alias: string
  readonly expr: ExprNode
  /** Codec used to decode this field from the driver row. */
  readonly codec: Schema.Schema<any, any>
}

/** One expression and direction in an `ORDER BY` clause. */
export interface OrderByTerm {
  readonly expr: ExprNode
  readonly direction: "asc" | "desc"
}

/** One column assignment in an update statement. */
export interface AssignmentTerm {
  readonly column: string
  readonly value: ExprNode
}

// --- statements -------------------------------------------------------------

interface BaseIR {
  readonly id: string
  readonly capabilities: CapabilityBits
  readonly annotations: QueryAnnotations
  readonly cardinality: Cardinality
}

/** Runtime representation of a select statement. */
export interface SelectIR extends BaseIR {
  readonly _tag: "Select"
  readonly from: TableSource
  readonly selection: ReadonlyArray<SelectionField>
  readonly where?: ExprNode
  readonly orderBy: ReadonlyArray<OrderByTerm>
  readonly limit?: number
  readonly offset?: number
}

/** Runtime representation of an insert statement. */
export interface InsertIR extends BaseIR {
  readonly _tag: "Insert"
  readonly into: TableSource
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<ExprNode>>
  readonly returning?: ReadonlyArray<SelectionField>
}

/** Runtime representation of an update statement. */
export interface UpdateIR extends BaseIR {
  readonly _tag: "Update"
  readonly table: TableSource
  readonly set: ReadonlyArray<AssignmentTerm>
  readonly where?: ExprNode
  readonly returning?: ReadonlyArray<SelectionField>
}

/** Runtime representation of a delete statement. */
export interface DeleteIR extends BaseIR {
  readonly _tag: "Delete"
  readonly from: TableSource
  readonly where?: ExprNode
  readonly returning?: ReadonlyArray<SelectionField>
}

/** Discriminated union accepted by guards, dialects, and execution. */
export type QueryIR = SelectIR | InsertIR | UpdateIR | DeleteIR

// --- ids --------------------------------------------------------------------

let counter = 0
/**
 * Creates a monotonic, process-local IR identifier.
 *
 * @param kind - Statement or node kind used as the identifier prefix.
 * @returns A value such as `Select#1`.
 * @remarks IDs support diagnostics only; cache keys are structural.
 */
export const nextId = (kind: string): string => `${kind}#${++counter}`

/**
 * Collects parameters referenced anywhere in an expression tree.
 *
 * @param expr - Root expression, or `undefined` for an empty expression.
 * @param out - Mutable accumulator used by recursive calls.
 * @returns The accumulator in source traversal order.
 */
export const collectParams = (expr: ExprNode | undefined, out: ParamNode[] = []): ParamNode[] => {
  if (!expr) return out
  switch (expr._tag) {
    case "Param":
      out.push(expr)
      break
    case "Comparison":
      collectParams(expr.left, out)
      collectParams(expr.right, out)
      break
    case "InList":
      collectParams(expr.expr, out)
      for (const v of expr.values) collectParams(v, out)
      break
    case "Logical":
      for (const op of expr.operands) collectParams(op, out)
      break
    case "Not":
      collectParams(expr.expr, out)
      break
    case "IsNull":
      collectParams(expr.expr, out)
      break
    case "RawExpr":
      out.push(...expr.params)
      break
    case "ColumnRef":
    case "Literal":
      break
  }
  return out
}

/**
 * Collects parameters from every clause of a complete query.
 *
 * @param ir - Query representation to traverse.
 * @returns Parameters in compiler traversal order.
 */
export const collectQueryParams = (ir: QueryIR): ReadonlyArray<ParamNode> => {
  const out: ParamNode[] = []
  const selection = (fields: ReadonlyArray<SelectionField> | undefined): void => {
    for (const field of fields ?? []) collectParams(field.expr, out)
  }

  switch (ir._tag) {
    case "Select":
      selection(ir.selection)
      collectParams(ir.where, out)
      for (const term of ir.orderBy) collectParams(term.expr, out)
      break
    case "Insert":
      for (const row of ir.rows) for (const value of row) collectParams(value, out)
      selection(ir.returning)
      break
    case "Update":
      for (const assignment of ir.set) collectParams(assignment.value, out)
      collectParams(ir.where, out)
      selection(ir.returning)
      break
    case "Delete":
      collectParams(ir.where, out)
      selection(ir.returning)
      break
  }
  return out
}
