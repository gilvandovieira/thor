/**
 * Dialect-independent structural hashing for runtime query IR.
 *
 * Hash material includes every SQL-shaping choice while deliberately excluding
 * IR ids, codecs, annotations, and bound parameter values. Prepared handles can
 * therefore identify a stable shape without retaining or hashing user data.
 *
 * @module ir/structural-hash
 */
import type { ExprNode, QueryIR, QuerySource, SelectionField } from "./query-ir.js"
import { hashString } from "../internal/hash.js"
import { normalizeQuery } from "./normalize.js"

const structuralHashCache = new WeakMap<QueryIR, string>()

/**
 * Converts expression IR to value-independent JSON material.
 *
 * @param node - Expression to normalize.
 * @returns Plain structural material suitable for stable serialization.
 */
const expressionShape = (node: ExprNode): unknown => {
  switch (node._tag) {
    case "ColumnRef":
      return [node._tag, node.table, node.column, node.dataType]
    case "Param":
      return [node._tag, "value" in node ? "<bound>" : node.name]
    case "Literal":
      return [node._tag, node.value]
    case "Comparison":
      return [node._tag, node.op, expressionShape(node.left), expressionShape(node.right)]
    case "InList":
      return [node._tag, expressionShape(node.expr), node.values.map(expressionShape), node.negated]
    case "Logical":
      return [node._tag, node.op, node.operands.map(expressionShape)]
    case "Not":
      return [node._tag, expressionShape(node.expr)]
    case "IsNull":
      return [node._tag, expressionShape(node.expr), node.negated]
    case "RawExpr":
      return [
        node._tag,
        node.strings,
        node.values.map((value) => (value._tag === "UnsafeSql" ? [value._tag, value.sql] : expressionShape(value)))
      ]
    case "ScalarSubquery":
      return [node._tag, queryShape(node.query)]
    case "Exists":
      return [node._tag, queryShape(node.query), node.negated]
    case "InSubquery":
      return [node._tag, expressionShape(node.expr), queryShape(node.query), node.negated]
    case "FunctionCall":
      return [
        node._tag,
        node.schema ?? null,
        node.name,
        node.args.map(expressionShape),
        node.aggregate,
        node.star,
        node.declared,
        node.volatility,
        node.capabilities.toString()
      ]
    case "WindowFunction":
      return [
        node._tag,
        expressionShape(node.function),
        node.partitionBy.map(expressionShape),
        node.orderBy.map((term) => [expressionShape(term.expr), term.direction]),
        node.frame ?? null
      ]
    case "ExcludedRef":
      return [node._tag, node.column]
  }
}

/**
 * @param fields - Optional query selection.
 * @returns Value-independent selected aliases and expressions.
 */
const selectionShape = (fields: ReadonlyArray<SelectionField> | undefined): unknown =>
  fields?.map((field) => [field.alias, expressionShape(field.expr)])

/**
 * @param source - Relation source to serialize.
 * @returns Structural relation material.
 */
const sourceShape = (source: QuerySource): unknown => {
  if ("_tag" in source && source._tag === "SubquerySource") {
    return [source._tag, queryShape(source.query), source.alias]
  }
  if ("_tag" in source && source._tag === "CteSource") {
    return [source._tag, source.name, source.alias ?? null]
  }
  if ("_tag" in source && source._tag === "TableFunctionSource") {
    return [
      source._tag,
      source.schema ?? null,
      source.name,
      source.args.map(expressionShape),
      source.argTypes,
      source.alias,
      source.columns,
      source.capabilities.toString()
    ]
  }
  return ["TableSource", source.name, source.alias ?? null]
}

/**
 * Produces normalized, dialect-independent query-shape material.
 *
 * @param ir - Query representation to normalize.
 * @returns Plain structural data with parameter values removed.
 */
const queryShape = (ir: QueryIR): unknown => {
  const common = [ir._tag, ir.capabilities.toString(), ir.cardinality]
  switch (ir._tag) {
    case "Select":
      return [
        ...common,
        sourceShape(ir.from),
        selectionShape(ir.selection),
        (ir.ctes ?? []).map((cte) => [cte.name, queryShape(cte.query), cte.recursive]),
        (ir.joins ?? []).map((join) => [
          join.type,
          sourceShape(join.source),
          join.on ? expressionShape(join.on) : null,
          join.lateral
        ]),
        ir.distinct ?? false,
        ir.where ? expressionShape(ir.where) : null,
        (ir.groupBy ?? []).map(expressionShape),
        ir.having ? expressionShape(ir.having) : null,
        (ir.setOperations ?? []).map((operation) => [operation.type, queryShape(operation.query), operation.all]),
        ir.orderBy.map((term) => [expressionShape(term.expr), term.direction]),
        ir.limit ?? null,
        ir.offset ?? null
      ]
    case "Insert":
      return [
        ...common,
        [ir.into.name, ir.into.alias],
        ir.columns,
        ir.rows.map((row) => row.map(expressionShape)),
        ir.conflict
          ? [
              ir.conflict.kind,
              ir.conflict.kind === "onConflict" ? ir.conflict.target : null,
              ir.conflict.kind === "onConflict" ? ir.conflict.action : null,
              ir.conflict.set.map((assignment) => [assignment.column, expressionShape(assignment.value)])
            ]
          : null,
        selectionShape(ir.returning)
      ]
    case "Update":
      return [
        ...common,
        [ir.table.name, ir.table.alias],
        ir.set.map((assignment) => [assignment.column, expressionShape(assignment.value)]),
        ir.where ? expressionShape(ir.where) : null,
        selectionShape(ir.returning)
      ]
    case "Delete":
      return [
        ...common,
        [ir.from.name, ir.from.alias],
        ir.where ? expressionShape(ir.where) : null,
        selectionShape(ir.returning)
      ]
    case "Call":
      return [...common, ir.schema ?? null, ir.procedure, ir.args.map(expressionShape)]
  }
}

/**
 * Computes a stable FNV-1a digest of value-independent query IR.
 *
 * @param ir - Query representation to hash.
 * @returns Eight-character hexadecimal structural hash.
 */
export const queryStructuralHash = (ir: QueryIR): string => {
  const cached = structuralHashCache.get(ir)
  if (cached !== undefined) return cached

  const normalized = normalizeQuery(ir)
  const material = JSON.stringify(queryShape(normalized))
  const hash = hashString(material)
  structuralHashCache.set(ir, hash)
  structuralHashCache.set(normalized, hash)
  return hash
}
