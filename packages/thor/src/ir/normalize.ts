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
import type { ExprNode, QueryIR, QuerySource, SelectIR, SelectionField } from "./query-ir.js"

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
    case "ExcludedRef":
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
    case "ScalarSubquery":
    case "Exists":
      return Object.freeze({ ...node, query: normalizeQuery(node.query) as SelectIR })
    case "InSubquery":
      return Object.freeze({
        ...node,
        expr: normalizeExpression(node.expr),
        query: normalizeQuery(node.query) as SelectIR
      })
    case "FunctionCall":
      return Object.freeze({ ...node, args: Object.freeze(node.args.map(normalizeExpression)) })
    case "WindowFunction":
      return Object.freeze({
        ...node,
        function: normalizeExpression(node.function) as typeof node.function,
        partitionBy: Object.freeze(node.partitionBy.map(normalizeExpression)),
        orderBy: Object.freeze(
          node.orderBy.map((term) => Object.freeze({ ...term, expr: normalizeExpression(term.expr) }))
        )
      })
  }
}

/**
 * @param source - Relation source to normalize.
 * @returns Frozen source with normalized nested query when present.
 */
const normalizeSource = (source: QuerySource): QuerySource =>
  "_tag" in source && source._tag === "SubquerySource"
    ? Object.freeze({ ...source, query: normalizeQuery(source.query) as SelectIR })
    : Object.freeze({ ...source })

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
        from: normalizeSource(ir.from),
        selection: normalizeSelection(ir.selection),
        ...(ir.ctes ? {
          ctes: Object.freeze(ir.ctes.map((cte) => Object.freeze({
            ...cte,
            query: normalizeQuery(cte.query) as SelectIR
          })))
        } : {}),
        ...(ir.joins ? {
          joins: Object.freeze(ir.joins.map((join) => Object.freeze({
            ...join,
            source: normalizeSource(join.source),
            ...(join.on ? { on: normalizeExpression(join.on) } : {})
          })))
        } : {}),
        ...(ir.where ? { where: normalizeExpression(ir.where) } : {}),
        ...(ir.groupBy ? { groupBy: Object.freeze(ir.groupBy.map(normalizeExpression)) } : {}),
        ...(ir.having ? { having: normalizeExpression(ir.having) } : {}),
        ...(ir.setOperations ? {
          setOperations: Object.freeze(ir.setOperations.map((operation) => Object.freeze({
            ...operation,
            query: normalizeQuery(operation.query) as SelectIR
          })))
        } : {}),
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
        ...(ir.conflict ? {
          conflict: Object.freeze({
            ...ir.conflict,
            ...(ir.conflict.kind === "onConflict" ? { target: Object.freeze([...ir.conflict.target]) } : {}),
            set: Object.freeze(ir.conflict.set.map((assignment) => Object.freeze({
              ...assignment,
              value: normalizeExpression(assignment.value)
            })))
          })
        } : {}),
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
