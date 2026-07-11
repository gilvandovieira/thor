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
import type { SqlDataType } from "../schema/column.js"

/** Estimated row count of an operation. */
export type Cardinality = "zero" | "one" | "many"

/** Observability/optimization metadata attached to every node (spec §7.4). */
export interface QueryAnnotations {
  readonly operationName?: string
  readonly tableNames: ReadonlyArray<string>
  readonly estimatedCardinality?: Cardinality
  readonly idempotency?: "idempotent" | "non-idempotent" | "unknown"
  /** Whether a procedure call must run inside a transaction (spec §14.5). */
  readonly requiresTransaction?: boolean
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
  readonly dataType: SqlDataType
  /** Opaque lexical source identity; names alone cannot distinguish shadowing. */
  readonly sourceId: object
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

/** Explicitly unsafe dynamic SQL text embedded in a raw expression. */
export interface UnsafeSqlNode {
  readonly _tag: "UnsafeSql"
  readonly sql: string
}

/** One structural interpolation retained by a raw SQL expression. */
export type RawExprInterpolation = ParamNode | ColumnRefNode | UnsafeSqlNode

/** Raw SQL whose dynamic fragments remain structural until dialect compilation. */
export interface RawExprNode {
  readonly _tag: "RawExpr"
  readonly strings: ReadonlyArray<string>
  readonly values: ReadonlyArray<RawExprInterpolation>
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
  /** Optional declared schema; absent for built-in functions. */
  readonly schema?: string
  /** Whether the name came from a declared routine descriptor. */
  readonly declared: boolean
  /** Volatility metadata retained for optimization safety. */
  readonly volatility: "immutable" | "stable" | "volatile"
  /** Capabilities required by this call. */
  readonly capabilities: CapabilityBits
}

/** Window specification applied to a function expression. */
export type WindowFrameBoundaryNode =
  | { readonly _tag: "UnboundedPreceding" }
  | { readonly _tag: "Preceding"; readonly offset: number }
  | { readonly _tag: "CurrentRow" }
  | { readonly _tag: "Following"; readonly offset: number }
  | { readonly _tag: "UnboundedFollowing" }

/** Structured SQL window frame, safe to compile as syntax. */
export interface WindowFrameNode {
  readonly _tag: "WindowFrame"
  readonly unit: "rows" | "range" | "groups"
  readonly start: WindowFrameBoundaryNode
  readonly end: WindowFrameBoundaryNode
}

/** Window specification applied to a function expression. */
export interface WindowFunctionNode {
  readonly _tag: "WindowFunction"
  readonly function: FunctionCallNode
  readonly partitionBy: ReadonlyArray<ExprNode>
  readonly orderBy: ReadonlyArray<OrderByTerm>
  readonly frame?: WindowFrameNode | UnsafeSqlNode
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
  /** Opaque lexical source identity shared with its column references. */
  readonly sourceId: object
}

/** Derived table backed by a complete select query. */
export interface SubquerySource {
  readonly _tag: "SubquerySource"
  readonly query: SelectIR
  readonly alias: string
  readonly sourceId: object
}

/** Reference to a named common-table expression. */
export interface CteSource {
  readonly _tag: "CteSource"
  readonly name: string
  readonly alias?: string
  readonly sourceId: object
}

/** Declared table-valued function used as a relation source. */
export interface TableFunctionSource {
  readonly _tag: "TableFunctionSource"
  readonly schema?: string
  readonly name: string
  readonly args: ReadonlyArray<ExprNode>
  /** Declared argument types retained for dialect overload resolution. */
  readonly argTypes: ReadonlyArray<SqlDataType>
  readonly alias: string
  readonly columns: ReadonlyArray<string>
  readonly capabilities: CapabilityBits
  readonly sourceId: object
}

/** Any relation allowed in a `FROM` or `JOIN` clause. */
export type QuerySource = TableSource | SubquerySource | CteSource | TableFunctionSource

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

/** Runtime representation of a stored-procedure call. */
export interface CallIR extends BaseIR {
  readonly _tag: "Call"
  readonly schema?: string
  readonly procedure: string
  readonly args: ReadonlyArray<ExprNode>
}

/** @internal Low-level query IR is inspectable but not a v1 compatibility surface. */
export type QueryIR = SelectIR | InsertIR | UpdateIR | DeleteIR | CallIR

// --- snapshots ---------------------------------------------------------------

/**
 * Snapshots ordinary mutable application data captured by an inline parameter.
 * Arrays, records, dates, binary views, maps, and sets are copied recursively.
 * Mutable opaque class instances are rejected: retaining them would make a
 * reusable query observe later mutation, while cloning them can violate private
 * fields and constructor invariants. Frozen opaque values are retained as an
 * explicit immutable domain-value boundary.
 *
 * @param value - Inline application value.
 * @returns A frozen copy when the value has well-defined copy semantics.
 * @internal
 */
export const snapshotInlineValue = (value: unknown): unknown => {
  const seen = new WeakMap<object, unknown>()
  const visit = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current
    const cached = seen.get(current)
    if (cached !== undefined) return cached
    if (current instanceof Date) {
      const copy = new Date(current.getTime())
      seen.set(current, copy)
      return Object.freeze(copy)
    }
    if (current instanceof ArrayBuffer) {
      const copy = current.slice(0)
      seen.set(current, copy)
      return copy
    }
    if (ArrayBuffer.isView(current)) {
      const copy =
        current instanceof DataView
          ? new DataView(current.buffer.slice(current.byteOffset, current.byteOffset + current.byteLength))
          : (current.constructor as unknown as { from: (value: ArrayLike<unknown>) => ArrayBufferView }).from(
              current as unknown as ArrayLike<unknown>
            )
      seen.set(current, copy)
      return copy
    }
    if (current instanceof Map) {
      const copy = new Map<unknown, unknown>()
      seen.set(current, copy)
      for (const [key, item] of current) copy.set(visit(key), visit(item))
      return copy
    }
    if (current instanceof Set) {
      const copy = new Set<unknown>()
      seen.set(current, copy)
      for (const item of current) copy.add(visit(item))
      return copy
    }
    if (Array.isArray(current)) {
      const copy: unknown[] = []
      seen.set(current, copy)
      for (const item of current) copy.push(visit(item))
      return Object.freeze(copy)
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      if (Object.isFrozen(current)) return current
      throw new TypeError(
        `Mutable inline ${current.constructor?.name ?? "object"} values are unsupported; use an immutable value or a named parameter`
      )
    }
    const copy = Object.create(prototype) as Record<PropertyKey, unknown>
    seen.set(current, copy)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor) continue
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: descriptor.enumerable ?? false,
        writable: false,
        value: visit("value" in descriptor ? descriptor.value : Reflect.get(current, key))
      })
    }
    return Object.freeze(copy)
  }
  return visit(value)
}

/**
 * Creates an owned, deeply frozen query graph. Every IR record and collection is
 * copied, including parameter nodes and nested queries. Schema codecs remain
 * shared by identity: they are executable descriptors, not mutable query data.
 *
 * @param ir - Query graph owned by a builder or caller.
 * @returns A deeply frozen graph safe to retain in a terminal handle.
 * @internal
 */
export const snapshotQueryIR = (ir: QueryIR): QueryIR => {
  const queries = new WeakMap<QueryIR, QueryIR>()
  const parameters = new WeakMap<ParamNode, ParamNode>()

  const expression = (node: ExprNode): ExprNode => {
    switch (node._tag) {
      case "ColumnRef":
      case "Literal":
      case "ExcludedRef":
        return Object.freeze({ ...node })
      case "Param": {
        const cached = parameters.get(node)
        if (cached) return cached
        const copy = Object.freeze({
          ...node,
          ...(Object.hasOwn(node, "value") ? { value: snapshotInlineValue(node.value) } : {})
        })
        parameters.set(node, copy)
        return copy
      }
      case "Comparison":
        return Object.freeze({ ...node, left: expression(node.left), right: expression(node.right) })
      case "InList":
        return Object.freeze({
          ...node,
          expr: expression(node.expr),
          values: Object.freeze(node.values.map(expression))
        })
      case "Logical":
        return Object.freeze({ ...node, operands: Object.freeze(node.operands.map(expression)) })
      case "Not":
      case "IsNull":
        return Object.freeze({ ...node, expr: expression(node.expr) })
      case "RawExpr":
        return Object.freeze({
          ...node,
          strings: Object.freeze([...node.strings]),
          values: Object.freeze(
            node.values.map((value) =>
              value._tag === "Param" ? (expression(value) as ParamNode) : Object.freeze({ ...value })
            )
          )
        })
      case "ScalarSubquery":
      case "Exists":
        return Object.freeze({ ...node, query: query(node.query) as SelectIR })
      case "InSubquery":
        return Object.freeze({ ...node, expr: expression(node.expr), query: query(node.query) as SelectIR })
      case "FunctionCall":
        return Object.freeze({ ...node, args: Object.freeze(node.args.map(expression)) })
      case "WindowFunction":
        return Object.freeze({
          ...node,
          function: expression(node.function) as FunctionCallNode,
          partitionBy: Object.freeze(node.partitionBy.map(expression)),
          orderBy: Object.freeze(node.orderBy.map((term) => Object.freeze({ ...term, expr: expression(term.expr) }))),
          ...(node.frame
            ? {
                frame:
                  node.frame._tag === "UnsafeSql"
                    ? Object.freeze({ ...node.frame })
                    : Object.freeze({
                        ...node.frame,
                        start: Object.freeze({ ...node.frame.start }),
                        end: Object.freeze({ ...node.frame.end })
                      })
              }
            : {})
        })
    }
  }

  const source = (value: QuerySource): QuerySource => {
    if (!("_tag" in value)) return Object.freeze({ ...value })
    switch (value._tag) {
      case "SubquerySource":
        return Object.freeze({ ...value, query: query(value.query) as SelectIR })
      case "CteSource":
        return Object.freeze({ ...value })
      case "TableFunctionSource":
        return Object.freeze({
          ...value,
          args: Object.freeze(value.args.map(expression)),
          argTypes: Object.freeze([...value.argTypes]),
          columns: Object.freeze([...value.columns])
        })
    }
  }
  const selection = (fields: ReadonlyArray<SelectionField>): ReadonlyArray<SelectionField> =>
    Object.freeze(fields.map((field) => Object.freeze({ ...field, expr: expression(field.expr) })))
  const annotations = (value: QueryAnnotations): QueryAnnotations =>
    Object.freeze({
      ...value,
      tableNames: Object.freeze([...value.tableNames]),
      ...(value.tracing
        ? {
            tracing: Object.freeze({
              ...value.tracing,
              attributes: Object.freeze({ ...value.tracing.attributes })
            })
          }
        : {})
    })
  const assignments = (values: ReadonlyArray<AssignmentTerm>): ReadonlyArray<AssignmentTerm> =>
    Object.freeze(values.map((item) => Object.freeze({ ...item, value: expression(item.value) })))

  const query = (value: QueryIR): QueryIR => {
    const cached = queries.get(value)
    if (cached) return cached
    let copy: QueryIR
    switch (value._tag) {
      case "Select":
        copy = Object.freeze({
          ...value,
          annotations: annotations(value.annotations),
          from: source(value.from),
          selection: selection(value.selection),
          ...(value.ctes
            ? {
                ctes: Object.freeze(
                  value.ctes.map((cte) => Object.freeze({ ...cte, query: query(cte.query) as SelectIR }))
                )
              }
            : {}),
          ...(value.joins
            ? {
                joins: Object.freeze(
                  value.joins.map((join) =>
                    Object.freeze({
                      ...join,
                      source: source(join.source),
                      ...(join.on ? { on: expression(join.on) } : {})
                    })
                  )
                )
              }
            : {}),
          ...(value.where ? { where: expression(value.where) } : {}),
          ...(value.groupBy ? { groupBy: Object.freeze(value.groupBy.map(expression)) } : {}),
          ...(value.having ? { having: expression(value.having) } : {}),
          ...(value.setOperations
            ? {
                setOperations: Object.freeze(
                  value.setOperations.map((operation) =>
                    Object.freeze({ ...operation, query: query(operation.query) as SelectIR })
                  )
                )
              }
            : {}),
          orderBy: Object.freeze(value.orderBy.map((term) => Object.freeze({ ...term, expr: expression(term.expr) })))
        })
        break
      case "Insert":
        copy = Object.freeze({
          ...value,
          annotations: annotations(value.annotations),
          into: Object.freeze({ ...value.into }),
          columns: Object.freeze([...value.columns]),
          rows: Object.freeze(value.rows.map((row) => Object.freeze(row.map(expression)))),
          ...(value.conflict
            ? {
                conflict: Object.freeze({
                  ...value.conflict,
                  ...(value.conflict.kind === "onConflict"
                    ? { target: Object.freeze([...value.conflict.target]) }
                    : {}),
                  set: assignments(value.conflict.set)
                })
              }
            : {}),
          ...(value.returning ? { returning: selection(value.returning) } : {})
        })
        break
      case "Update":
        copy = Object.freeze({
          ...value,
          annotations: annotations(value.annotations),
          table: Object.freeze({ ...value.table }),
          set: assignments(value.set),
          ...(value.where ? { where: expression(value.where) } : {}),
          ...(value.returning ? { returning: selection(value.returning) } : {})
        })
        break
      case "Delete":
        copy = Object.freeze({
          ...value,
          annotations: annotations(value.annotations),
          from: Object.freeze({ ...value.from }),
          ...(value.where ? { where: expression(value.where) } : {}),
          ...(value.returning ? { returning: selection(value.returning) } : {})
        })
        break
      case "Call":
        copy = Object.freeze({
          ...value,
          annotations: annotations(value.annotations),
          args: Object.freeze(value.args.map(expression))
        })
        break
    }
    queries.set(value, copy)
    return copy
  }

  return query(ir)
}

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

export { collectQueryParams, queryCapabilityBits } from "./query-analysis.js"
