/**
 * Query construction & capability guards (spec §8.1).
 *
 * Guards are pure: `collectViolations` returns the tagged errors it finds so
 * they are trivially unit-testable (spec §14.6).
 *
 * @module guards/query-guards
 */
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import { bitsToCapabilities } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import {
  queryCapabilityBits,
  type ColumnRefNode,
  type ExprNode,
  type QueryIR,
  type QuerySource,
  type SelectIR
} from "../ir/query-ir.js"
import { CapabilityError, GuardError } from "../errors/index.js"

/** Structural or capability failure discovered before execution. */
export type Violation = GuardError | CapabilityError

/**
 * Recursively collects column references from an expression tree.
 *
 * @param node - Expression to traverse.
 * @param out - Mutable accumulator used during recursion.
 * @returns The populated accumulator.
 */
const columnRefsIn = (node: ExprNode | undefined, out: ColumnRefNode[] = []): ColumnRefNode[] => {
  if (!node) return out
  switch (node._tag) {
    case "ColumnRef":
      out.push(node)
      break
    case "Comparison":
      columnRefsIn(node.left, out)
      columnRefsIn(node.right, out)
      break
    case "InList":
      columnRefsIn(node.expr, out)
      for (const v of node.values) columnRefsIn(v, out)
      break
    case "Logical":
      for (const o of node.operands) columnRefsIn(o, out)
      break
    case "Not":
    case "IsNull":
      columnRefsIn(node.expr, out)
      break
    case "InSubquery":
      columnRefsIn(node.expr, out)
      break
    case "FunctionCall":
      for (const arg of node.args) columnRefsIn(arg, out)
      break
    case "WindowFunction":
      for (const arg of node.function.args) columnRefsIn(arg, out)
      for (const partition of node.partitionBy) columnRefsIn(partition, out)
      for (const term of node.orderBy) columnRefsIn(term.expr, out)
      break
    case "RawExpr":
      for (const value of node.values) {
        if (value._tag === "ColumnRef") out.push(value)
      }
      break
    default:
      break
  }
  return out
}

/**
 * Enforces the table-scope guard from spec §8.1.
 *
 * @param scope - Table names visible to the query.
 * @param refs - Column references to validate.
 * @param out - Mutable violation accumulator.
 * @returns Nothing; violations are appended to `out`.
 */
const checkScope = (scope: ReadonlySet<string>, refs: ReadonlyArray<ColumnRefNode>, out: Violation[]): void => {
  for (const ref of refs) {
    if (ref.table && !scope.has(ref.table)) {
      out.push(
        new GuardError({
          guard: "table-scope",
          message: `Column "${ref.table}"."${ref.column}" is not in query scope {${[...scope].join(", ")}}`
        })
      )
    }
  }
}

/**
 * @param source - Relation source.
 * @returns Name visible to column references.
 */
const sourceScopeName = (source: QuerySource): string => {
  if ("_tag" in source && source._tag === "SubquerySource") return source.alias
  return source.alias ?? source.name
}

/**
 * Visits select queries embedded inside an expression.
 *
 * @param node - Expression to traverse.
 * @param visit - Callback receiving each nested select.
 * @returns Nothing.
 */
const visitSubqueries = (node: ExprNode | undefined, visit: (query: SelectIR) => void): void => {
  if (!node) return
  switch (node._tag) {
    case "ScalarSubquery":
    case "Exists":
      visit(node.query)
      break
    case "InSubquery":
      visitSubqueries(node.expr, visit)
      visit(node.query)
      break
    case "Comparison":
      visitSubqueries(node.left, visit)
      visitSubqueries(node.right, visit)
      break
    case "InList":
      visitSubqueries(node.expr, visit)
      for (const value of node.values) visitSubqueries(value, visit)
      break
    case "Logical":
      for (const operand of node.operands) visitSubqueries(operand, visit)
      break
    case "Not":
    case "IsNull":
      visitSubqueries(node.expr, visit)
      break
    case "FunctionCall":
      for (const arg of node.args) visitSubqueries(arg, visit)
      break
    case "WindowFunction":
      for (const arg of node.function.args) visitSubqueries(arg, visit)
      for (const partition of node.partitionBy) visitSubqueries(partition, visit)
      for (const term of node.orderBy) visitSubqueries(term.expr, visit)
      break
    case "ColumnRef":
    case "Param":
    case "Literal":
    case "RawExpr":
    case "ExcludedRef":
      break
  }
}

/**
 * @param node - Expression to inspect.
 * @returns Whether the expression contains a non-window aggregate call.
 */
const containsAggregate = (node: ExprNode): boolean => {
  switch (node._tag) {
    case "FunctionCall":
      return node.aggregate || node.args.some(containsAggregate)
    case "Comparison":
      return containsAggregate(node.left) || containsAggregate(node.right)
    case "InList":
      return containsAggregate(node.expr) || node.values.some(containsAggregate)
    case "Logical":
      return node.operands.some(containsAggregate)
    case "Not":
    case "IsNull":
      return containsAggregate(node.expr)
    case "InSubquery":
      return containsAggregate(node.expr)
    case "WindowFunction":
    case "ColumnRef":
    case "Param":
    case "Literal":
    case "RawExpr":
    case "ScalarSubquery":
    case "Exists":
    case "ExcludedRef":
      return false
  }
}

/**
 * Collects column references evaluated outside aggregate/window calls.
 *
 * @param node - Expression to traverse.
 * @param out - Mutable column accumulator.
 * @returns The populated accumulator.
 */
const unaggregatedRefsIn = (node: ExprNode, out: ColumnRefNode[] = []): ColumnRefNode[] => {
  if (node._tag === "FunctionCall" && node.aggregate) return out
  if (node._tag === "WindowFunction") return out
  switch (node._tag) {
    case "ColumnRef":
      out.push(node)
      break
    case "Comparison":
      unaggregatedRefsIn(node.left, out)
      unaggregatedRefsIn(node.right, out)
      break
    case "InList":
      unaggregatedRefsIn(node.expr, out)
      for (const value of node.values) unaggregatedRefsIn(value, out)
      break
    case "Logical":
      for (const operand of node.operands) unaggregatedRefsIn(operand, out)
      break
    case "Not":
    case "IsNull":
      unaggregatedRefsIn(node.expr, out)
      break
    case "InSubquery":
      unaggregatedRefsIn(node.expr, out)
      break
    case "FunctionCall":
      for (const arg of node.args) unaggregatedRefsIn(arg, out)
      break
    case "RawExpr":
      for (const value of node.values) {
        if (value._tag === "ColumnRef") out.push(value)
      }
      break
    case "Param":
    case "Literal":
    case "ScalarSubquery":
    case "Exists":
    case "ExcludedRef":
      break
  }
  return out
}

/**
 * Validates one select and all nested selects.
 *
 * @param ir - Select representation.
 * @param outerScope - Correlation scope inherited from an expression/lateral parent.
 * @param out - Mutable guard-error accumulator.
 * @returns Nothing.
 */
const validateSelect = (ir: SelectIR, outerScope: ReadonlySet<string>, out: GuardError[]): void => {
  for (const cte of ir.ctes ?? []) validateSelect(cte.query, new Set(), out)

  if ("_tag" in ir.from && ir.from._tag === "SubquerySource") {
    validateSelect(ir.from.query, new Set(), out)
  }
  if ("_tag" in ir.from && ir.from._tag === "TableFunctionSource") {
    checkScope(
      outerScope,
      ir.from.args.flatMap((arg) => columnRefsIn(arg)),
      out
    )
    for (const arg of ir.from.args) visitSubqueries(arg, (query) => validateSelect(query, outerScope, out))
  }
  const localScope = new Set<string>(outerScope)
  localScope.add(sourceScopeName(ir.from))

  for (const join of ir.joins ?? []) {
    if ("_tag" in join.source && join.source._tag === "SubquerySource") {
      validateSelect(join.source.query, join.lateral ? localScope : new Set(), out)
    }
    if ("_tag" in join.source && join.source._tag === "TableFunctionSource") {
      const argumentScope = join.lateral ? localScope : new Set<string>()
      checkScope(
        argumentScope,
        join.source.args.flatMap((arg) => columnRefsIn(arg)),
        out
      )
      for (const arg of join.source.args) {
        visitSubqueries(arg, (query) => validateSelect(query, argumentScope, out))
      }
    }
    const joinScope = new Set(localScope)
    joinScope.add(sourceScopeName(join.source))
    checkScope(joinScope, columnRefsIn(join.on), out)
    localScope.add(sourceScopeName(join.source))
  }

  const expressions = [
    ...ir.selection.map((field) => field.expr),
    ...(ir.where ? [ir.where] : []),
    ...(ir.groupBy ?? []),
    ...(ir.having ? [ir.having] : []),
    ...ir.orderBy.map((term) => term.expr)
  ]
  checkScope(
    localScope,
    expressions.flatMap((expression) => columnRefsIn(expression)),
    out
  )
  for (const expression of expressions) {
    visitSubqueries(expression, (query) => validateSelect(query, localScope, out))
  }

  const aggregationActive =
    (ir.groupBy?.length ?? 0) > 0 ||
    ir.selection.some((field) => containsAggregate(field.expr)) ||
    (ir.having ? containsAggregate(ir.having) : false)
  if (aggregationActive) {
    const grouped = new Set(
      (ir.groupBy ?? []).flatMap((expression) => columnRefsIn(expression)).map((ref) => `${ref.table}.${ref.column}`)
    )
    const checked = [...ir.selection.map((field) => field.expr), ...(ir.having ? [ir.having] : [])]
    for (const ref of checked.flatMap((expression) => unaggregatedRefsIn(expression))) {
      if (!grouped.has(`${ref.table}.${ref.column}`)) {
        out.push(
          new GuardError({
            guard: "aggregation-scope",
            message: `Column "${ref.table}"."${ref.column}" must appear in groupBy or an aggregate`
          })
        )
      }
    }
  }

  for (const operation of ir.setOperations ?? []) {
    if (operation.query.selection.length !== ir.selection.length) {
      out.push(
        new GuardError({
          guard: "set-operation-shape",
          message: `Set operation has ${operation.query.selection.length} fields; expected ${ir.selection.length}`
        })
      )
    }
    validateSelect(operation.query, outerScope, out)
  }
}

/**
 * Validates mutation expressions and any correlated selects nested within them.
 *
 * @param expressions - Expressions evaluated by the mutation.
 * @param scope - Mutation relations visible to direct references and correlations.
 * @param out - Mutable guard-error accumulator.
 * @returns Nothing.
 */
const validateMutationExpressions = (
  expressions: ReadonlyArray<ExprNode>,
  scope: ReadonlySet<string>,
  out: GuardError[]
): void => {
  checkScope(
    scope,
    expressions.flatMap((expression) => columnRefsIn(expression)),
    out
  )
  for (const expression of expressions) {
    visitSubqueries(expression, (query) => validateSelect(query, scope, out))
  }
}

/**
 * Runs guards that depend only on the immutable query shape.
 *
 * @param ir - Query representation to validate.
 * @returns Structural violations, or an empty array when the shape is valid.
 */
export const collectStructuralViolations = (ir: QueryIR): ReadonlyArray<GuardError> => {
  const out: GuardError[] = []
  switch (ir._tag) {
    case "Select": {
      validateSelect(ir, new Set(), out)
      break
    }
    case "Insert": {
      if (ir.columns.length === 0) {
        out.push(new GuardError({ guard: "insert-shape", message: "Insert has no columns" }))
      }
      for (const [i, row] of ir.rows.entries()) {
        if (row.length !== ir.columns.length) {
          out.push(
            new GuardError({
              guard: "insert-shape",
              message: `Insert row ${i} has ${row.length} values but ${ir.columns.length} columns`
            })
          )
        }
      }
      if (ir.conflict?.kind === "onConflict" && ir.conflict.action === "update") {
        if (ir.conflict.target.length === 0) {
          out.push(
            new GuardError({
              guard: "insert-conflict-shape",
              message: "ON CONFLICT DO UPDATE requires at least one target column"
            })
          )
        }
        if (ir.conflict.set.length === 0) {
          out.push(
            new GuardError({
              guard: "insert-conflict-shape",
              message: "ON CONFLICT DO UPDATE requires at least one assignment"
            })
          )
        }
      }
      if (ir.conflict?.kind === "onDuplicateKey" && ir.conflict.set.length === 0) {
        out.push(
          new GuardError({
            guard: "insert-conflict-shape",
            message: "ON DUPLICATE KEY UPDATE requires at least one assignment"
          })
        )
      }
      const targetScope = new Set([ir.into.name])
      validateMutationExpressions(ir.rows.flat(), new Set(), out)
      validateMutationExpressions(ir.conflict?.set.map((assignment) => assignment.value) ?? [], targetScope, out)
      validateMutationExpressions(
        (ir.returning ?? []).map((field) => field.expr),
        targetScope,
        out
      )
      break
    }
    case "Update": {
      if (ir.set.length === 0) {
        out.push(new GuardError({ guard: "update-shape", message: "Update has an empty SET clause" }))
      }
      const scope = new Set([ir.table.name])
      validateMutationExpressions(
        [
          ...ir.set.map((assignment) => assignment.value),
          ...(ir.where ? [ir.where] : []),
          ...(ir.returning ?? []).map((field) => field.expr)
        ],
        scope,
        out
      )
      break
    }
    case "Delete": {
      const scope = new Set([ir.from.name])
      validateMutationExpressions(
        [...(ir.where ? [ir.where] : []), ...(ir.returning ?? []).map((field) => field.expr)],
        scope,
        out
      )
      break
    }
    case "Call": {
      if (ir.procedure.length === 0) {
        out.push(new GuardError({ guard: "routine-shape", message: "Procedure name cannot be empty" }))
      }
      break
    }
  }
  return out
}

/**
 * Runs guards whose result depends on a dialect capability profile.
 *
 * @param ir - Query representation to validate.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns Capability violations, or an empty array when every requirement is satisfied.
 */
export const collectCapabilityViolations = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation = false
): ReadonlyArray<CapabilityError> => {
  const out: CapabilityError[] = []
  for (const capability of bitsToCapabilities(queryCapabilityBits(ir))) {
    if (!isSatisfied(matrix, capability, allowEmulation)) {
      out.push(
        new CapabilityError({
          capability,
          dialect: matrix.dialect,
          message: `Capability "${capability}" is not available on dialect "${matrix.dialect}"`
        })
      )
    }
  }
  return out
}

/**
 * Runs every structural and capability guard against query IR.
 *
 * @param ir - Query representation to validate.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns Every discovered violation, or an empty array when valid.
 */
export const collectViolations = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation = false
): ReadonlyArray<Violation> => [
  ...collectCapabilityViolations(ir, matrix, allowEmulation),
  ...collectStructuralViolations(ir)
]
