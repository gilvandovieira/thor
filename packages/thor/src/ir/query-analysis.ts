/**
 * Parameter and capability traversal for runtime query IR.
 *
 * @module ir/query-analysis
 */
import type { CapabilityBits } from "../capabilities/capability.js"
import type { ExprNode, ParamNode, QueryIR, SelectionField } from "./query-ir.js"

/**
 * Collects parameters referenced anywhere in an expression tree.
 *
 * @param expr - Root expression, or `undefined` for an empty expression.
 * @param out - Mutable accumulator used by recursive calls.
 * @returns The accumulator in source traversal order.
 */
const collectParams = (expr: ExprNode | undefined, out: ParamNode[] = []): ParamNode[] => {
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
      for (const value of expr.values) collectParams(value, out)
      break
    case "Logical":
      for (const operand of expr.operands) collectParams(operand, out)
      break
    case "Not":
    case "IsNull":
      collectParams(expr.expr, out)
      break
    case "RawExpr":
      for (const value of expr.values) if (value._tag === "Param") out.push(value)
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
      if ("_tag" in ir.from && ir.from._tag === "TableFunctionSource") {
        for (const arg of ir.from.args) collectParams(arg, out)
      }
      for (const join of ir.joins ?? []) {
        if ("_tag" in join.source && join.source._tag === "SubquerySource") collectQueryParams(join.source.query, out)
        if ("_tag" in join.source && join.source._tag === "TableFunctionSource") {
          for (const arg of join.source.args) collectParams(arg, out)
        }
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
    case "Call":
      for (const arg of ir.args) collectParams(arg, out)
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
        bits |= node.capabilities
        for (const arg of node.args) expression(arg)
        break
      case "WindowFunction":
        expression(node.function)
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
      if ("_tag" in ir.from && ir.from._tag === "TableFunctionSource") {
        bits |= ir.from.capabilities
        for (const arg of ir.from.args) expression(arg)
      }
      for (const join of ir.joins ?? []) {
        if ("_tag" in join.source && join.source._tag === "SubquerySource")
          bits |= queryCapabilityBits(join.source.query)
        if ("_tag" in join.source && join.source._tag === "TableFunctionSource") {
          bits |= join.source.capabilities
          for (const arg of join.source.args) expression(arg)
        }
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
    case "Call":
      for (const arg of ir.args) expression(arg)
      break
  }
  return bits
}
