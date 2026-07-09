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

/** Scalar subquery used as an expression. */
export interface ScalarSubqueryNode {
  readonly _tag: "ScalarSubquery"
  readonly query: SelectIR
}

/** `EXISTS` or `NOT EXISTS` predicate. */
export interface ExistsNode {
  readonly _tag: "Exists"
  readonly query: SelectIR
  readonly negated: boolean
}

/** `IN (subquery)` or `NOT IN (subquery)` predicate. */
export interface InSubqueryNode {
  readonly _tag: "InSubquery"
  readonly expr: ExprNode
  readonly query: SelectIR
  readonly negated: boolean
}

/** SQL function call, including aggregate functions. */
export interface FunctionCallNode {
  readonly _tag: "FunctionCall"
  readonly name: string
  readonly args: ReadonlyArray<ExprNode>
  readonly aggregate: boolean
  readonly star: boolean
}

/** Window specification applied to a function expression. */
export interface WindowFunctionNode {
  readonly _tag: "WindowFunction"
  readonly function: FunctionCallNode
  readonly partitionBy: ReadonlyArray<ExprNode>
  readonly orderBy: ReadonlyArray<OrderByTerm>
  readonly frame?: string
}

/** Reference to the candidate row in an upsert update. */
export interface ExcludedRefNode {
  readonly _tag: "ExcludedRef"
  readonly column: string
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
  | ScalarSubqueryNode
  | ExistsNode
  | InSubqueryNode
  | FunctionCallNode
  | WindowFunctionNode
  | ExcludedRefNode

// --- clauses ----------------------------------------------------------------

/** Table source used by statement IR. */
export interface TableSource {
  readonly name: string
  readonly alias?: string
}

/** Derived table backed by a complete select query. */
export interface SubquerySource {
  readonly _tag: "SubquerySource"
  readonly query: SelectIR
  readonly alias: string
}

/** Reference to a named common-table expression. */
export interface CteSource {
  readonly _tag: "CteSource"
  readonly name: string
  readonly alias?: string
}

/** Any relation allowed in a `FROM` or `JOIN` clause. */
export type QuerySource = TableSource | SubquerySource | CteSource

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

/** Join kind supported by select IR. */
export type JoinType = "inner" | "left" | "right" | "full" | "cross"

/** One joined relation and its optional join predicate. */
export interface JoinTerm {
  readonly type: JoinType
  readonly source: QuerySource
  readonly on?: ExprNode
  readonly lateral: boolean
}

/** Named query evaluated before a select. */
export interface CommonTableExpression {
  readonly name: string
  readonly query: SelectIR
  readonly recursive: boolean
}

/** SQL set operation applied to another select. */
export interface SetOperation {
  readonly type: "union" | "intersect" | "except"
  readonly query: SelectIR
  readonly all: boolean
}

/** Insert conflict behavior rendered according to the target dialect. */
export type InsertConflict =
  | {
      readonly kind: "onConflict"
      readonly target: ReadonlyArray<string>
      readonly action: "nothing" | "update"
      readonly set: ReadonlyArray<AssignmentTerm>
    }
  | {
      readonly kind: "onDuplicateKey"
      readonly set: ReadonlyArray<AssignmentTerm>
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
  readonly from: QuerySource
  readonly selection: ReadonlyArray<SelectionField>
  readonly ctes?: ReadonlyArray<CommonTableExpression>
  readonly joins?: ReadonlyArray<JoinTerm>
  readonly distinct?: boolean
  readonly where?: ExprNode
  readonly groupBy?: ReadonlyArray<ExprNode>
  readonly having?: ExprNode
  readonly setOperations?: ReadonlyArray<SetOperation>
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
  readonly conflict?: InsertConflict
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
    case "ScalarSubquery":
    case "Exists":
      collectQueryParams(expr.query, out)
      break
    case "InSubquery":
      collectParams(expr.expr, out)
      collectQueryParams(expr.query, out)
      break
    case "FunctionCall":
      for (const arg of expr.args) collectParams(arg, out)
      break
    case "WindowFunction":
      for (const arg of expr.function.args) collectParams(arg, out)
      for (const partition of expr.partitionBy) collectParams(partition, out)
      for (const term of expr.orderBy) collectParams(term.expr, out)
      break
    case "ColumnRef":
    case "Literal":
    case "ExcludedRef":
      break
  }
  return out
}

/**
 * Collects parameters from every clause of a complete query.
 *
 * @param ir - Query representation to traverse.
 * @param out - Mutable accumulator used by nested-query traversal.
 * @returns Parameters in compiler traversal order.
 */
export const collectQueryParams = (ir: QueryIR, out: ParamNode[] = []): ReadonlyArray<ParamNode> => {
  const selection = (fields: ReadonlyArray<SelectionField> | undefined): void => {
    for (const field of fields ?? []) collectParams(field.expr, out)
  }

  switch (ir._tag) {
    case "Select":
      for (const cte of ir.ctes ?? []) collectQueryParams(cte.query, out)
      selection(ir.selection)
      if ("_tag" in ir.from && ir.from._tag === "SubquerySource") collectQueryParams(ir.from.query, out)
      for (const join of ir.joins ?? []) {
        if ("_tag" in join.source && join.source._tag === "SubquerySource") collectQueryParams(join.source.query, out)
        collectParams(join.on, out)
      }
      collectParams(ir.where, out)
      for (const expr of ir.groupBy ?? []) collectParams(expr, out)
      collectParams(ir.having, out)
      for (const operation of ir.setOperations ?? []) collectQueryParams(operation.query, out)
      for (const term of ir.orderBy) collectParams(term.expr, out)
      break
    case "Insert":
      for (const row of ir.rows) for (const value of row) collectParams(value, out)
      if (ir.conflict && (ir.conflict.kind === "onDuplicateKey" || ir.conflict.action === "update")) {
        for (const assignment of ir.conflict.set) collectParams(assignment.value, out)
      }
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

/**
 * Recursively collects capability bits from a query and every nested query.
 *
 * @param ir - Query representation to inspect.
 * @returns Union of direct and nested capability requirements.
 */
export const queryCapabilityBits = (ir: QueryIR): CapabilityBits => {
  let bits = ir.capabilities
  const expression = (node: ExprNode | undefined): void => {
    if (!node) return
    switch (node._tag) {
      case "Comparison":
        expression(node.left)
        expression(node.right)
        break
      case "InList":
        expression(node.expr)
        for (const value of node.values) expression(value)
        break
      case "Logical":
        for (const operand of node.operands) expression(operand)
        break
      case "Not":
      case "IsNull":
        expression(node.expr)
        break
      case "ScalarSubquery":
      case "Exists":
        bits |= queryCapabilityBits(node.query)
        break
      case "InSubquery":
        expression(node.expr)
        bits |= queryCapabilityBits(node.query)
        break
      case "FunctionCall":
        for (const arg of node.args) expression(arg)
        break
      case "WindowFunction":
        for (const arg of node.function.args) expression(arg)
        for (const item of node.partitionBy) expression(item)
        for (const term of node.orderBy) expression(term.expr)
        break
      case "ColumnRef":
      case "Param":
      case "Literal":
      case "RawExpr":
      case "ExcludedRef":
        break
    }
  }
  const selection = (fields: ReadonlyArray<SelectionField> | undefined): void => {
    for (const field of fields ?? []) expression(field.expr)
  }

  switch (ir._tag) {
    case "Select":
      for (const cte of ir.ctes ?? []) bits |= queryCapabilityBits(cte.query)
      selection(ir.selection)
      if ("_tag" in ir.from && ir.from._tag === "SubquerySource") bits |= queryCapabilityBits(ir.from.query)
      for (const join of ir.joins ?? []) {
        if ("_tag" in join.source && join.source._tag === "SubquerySource") bits |= queryCapabilityBits(join.source.query)
        expression(join.on)
      }
      expression(ir.where)
      for (const item of ir.groupBy ?? []) expression(item)
      expression(ir.having)
      for (const operation of ir.setOperations ?? []) bits |= queryCapabilityBits(operation.query)
      for (const term of ir.orderBy) expression(term.expr)
      break
    case "Insert":
      for (const row of ir.rows) for (const value of row) expression(value)
      if (ir.conflict && (ir.conflict.kind === "onDuplicateKey" || ir.conflict.action === "update")) {
        for (const assignment of ir.conflict.set) expression(assignment.value)
      }
      selection(ir.returning)
      break
    case "Update":
      for (const assignment of ir.set) expression(assignment.value)
      expression(ir.where)
      selection(ir.returning)
      break
    case "Delete":
      expression(ir.where)
      selection(ir.returning)
      break
  }
  return bits
}
