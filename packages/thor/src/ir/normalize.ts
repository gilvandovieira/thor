/**
 * Order-preserving normalization for immutable runtime query IR.
 *
 * Normalization flattens nested logical nodes with the same operator and
 * recursively normalizes every expression-bearing clause. It never sorts or
 * deduplicates operands, so parameter order and volatile SQL call order remain
 * exactly as authored.
 *
 * @module ir/normalize
 */
import type { ExprNode, QueryIR, SelectionField } from "./query-ir.js"

const normalizedQueries = new WeakSet<QueryIR>()
const normalizationCache = new WeakMap<QueryIR, QueryIR>()

/**
 * Recursively normalizes expression structure without reordering operands.
 *
 * @param node - Expression node to normalize.
 * @returns An equivalent normalized expression.
 */
const normalizeExpression = (node: ExprNode): ExprNode => {
  switch (node._tag) {
    case "ColumnRef":
    case "Param":
    case "Literal":
    case "RawExpr":
      return node
    case "Comparison":
      return Object.freeze({
        ...node,
        left: normalizeExpression(node.left),
        right: normalizeExpression(node.right)
      })
    case "InList":
      return Object.freeze({
        ...node,
        expr: normalizeExpression(node.expr),
        values: Object.freeze(node.values.map(normalizeExpression))
      })
    case "Logical": {
      const operands: ExprNode[] = []
      for (const operand of node.operands) {
        const normalized = normalizeExpression(operand)
        if (normalized._tag === "Logical" && normalized.op === node.op) {
          operands.push(...normalized.operands)
        } else {
          operands.push(normalized)
        }
      }
      return Object.freeze({ ...node, operands: Object.freeze(operands) })
    }
    case "Not":
      return Object.freeze({ ...node, expr: normalizeExpression(node.expr) })
    case "IsNull":
      return Object.freeze({ ...node, expr: normalizeExpression(node.expr) })
  }
}

/**
 * @param fields - Selected fields to normalize.
 * @returns Frozen selection with normalized expressions.
 */
const normalizeSelection = (fields: ReadonlyArray<SelectionField>): ReadonlyArray<SelectionField> =>
  Object.freeze(fields.map((field) => Object.freeze({ ...field, expr: normalizeExpression(field.expr) })))

/**
 * Normalizes a query once per IR identity.
 *
 * Re-normalizing an already normalized query returns the same object. The
 * function is pure with respect to its input and retains parameter/value nodes,
 * codecs, annotations, ids, capabilities, and clause order.
 *
 * @param ir - Immutable query representation.
 * @returns A frozen normalized query representation.
 */
export const normalizeQuery = (ir: QueryIR): QueryIR => {
  if (normalizedQueries.has(ir)) return ir
  const cached = normalizationCache.get(ir)
  if (cached !== undefined) return cached

  let normalized: QueryIR
  switch (ir._tag) {
    case "Select":
      normalized = Object.freeze({
        ...ir,
        selection: normalizeSelection(ir.selection),
        ...(ir.where ? { where: normalizeExpression(ir.where) } : {}),
        orderBy: Object.freeze(
          ir.orderBy.map((term) => Object.freeze({ ...term, expr: normalizeExpression(term.expr) }))
        )
      })
      break
    case "Insert":
      normalized = Object.freeze({
        ...ir,
        columns: Object.freeze([...ir.columns]),
        rows: Object.freeze(
          ir.rows.map((row) => Object.freeze(row.map(normalizeExpression)))
        ),
        ...(ir.returning ? { returning: normalizeSelection(ir.returning) } : {})
      })
      break
    case "Update":
      normalized = Object.freeze({
        ...ir,
        set: Object.freeze(
          ir.set.map((assignment) =>
            Object.freeze({ ...assignment, value: normalizeExpression(assignment.value) })
          )
        ),
        ...(ir.where ? { where: normalizeExpression(ir.where) } : {}),
        ...(ir.returning ? { returning: normalizeSelection(ir.returning) } : {})
      })
      break
    case "Delete":
      normalized = Object.freeze({
        ...ir,
        ...(ir.where ? { where: normalizeExpression(ir.where) } : {}),
        ...(ir.returning ? { returning: normalizeSelection(ir.returning) } : {})
      })
      break
  }

  normalizedQueries.add(normalized)
  normalizationCache.set(ir, normalized)
  normalizationCache.set(normalized, normalized)
  return normalized
}
