/**
 * Shared runtime-IR compiler used by concrete database dialects.
 *
 * The compiler owns statement structure and parameter ordering. Dialects supply
 * identifier quoting, placeholders, and comparison rendering.
 *
 * @module sql/compiler
 */
import type { CompiledQuery } from "../execution/driver.js"
import type {
  DeleteIR,
  ExprNode,
  InsertIR,
  OrderByTerm,
  ParamNode,
  QueryIR,
  SelectionField,
  SelectIR,
  TableSource,
  UpdateIR
} from "../ir/query-ir.js"
import type { Dialect } from "../dialect.js"
import { queryStructuralHash } from "../ir/structural-hash.js"
import { normalizeQuery } from "../ir/normalize.js"

interface CompileContext {
  readonly dialect: Dialect
  readonly params: ParamNode[]
}

/**
 * @param context - Active compiler state.
 * @param source - Table source and optional alias.
 * @returns A dialect-quoted table reference.
 */
const compileSource = (context: CompileContext, source: TableSource): string => {
  const name = context.dialect.quoteIdent(source.name)
  return source.alias ? `${name} ${context.dialect.quoteIdent(source.alias)}` : name
}

/**
 * Appends raw-expression parameters and rebases its local placeholders.
 *
 * @param context - Active compiler state.
 * @param node - Trusted raw expression node.
 * @returns Raw SQL with dialect placeholders.
 */
const compileRaw = (context: CompileContext, node: Extract<ExprNode, { readonly _tag: "RawExpr" }>): string => {
  const offset = context.params.length
  context.params.push(...node.params)
  return node.sql.replace(/\$(\d+)/g, (_, localIndex: string) =>
    context.dialect.placeholder(offset + Number(localIndex))
  )
}

/**
 * Recursively compiles one expression and records encountered parameters.
 *
 * @param context - Active compiler state.
 * @param node - Expression representation.
 * @returns Dialect-specific SQL expression text.
 */
const compileExpr = (context: CompileContext, node: ExprNode): string => {
  switch (node._tag) {
    case "ColumnRef": {
      const column = context.dialect.quoteIdent(node.column)
      return node.table ? `${context.dialect.quoteIdent(node.table)}.${column}` : column
    }
    case "Param":
      context.params.push(node)
      return context.dialect.placeholder(context.params.length)
    case "Literal": {
      const value = node.value
      if (value === null) return "NULL"
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
      if (typeof value === "number") return String(value)
      return `'${value.replace(/'/g, "''")}'`
    }
    case "Comparison":
      return context.dialect.comparison(
        compileExpr(context, node.left),
        node.op,
        compileExpr(context, node.right)
      )
    case "InList": {
      const values = node.values.map((value) => compileExpr(context, value)).join(", ")
      return `${compileExpr(context, node.expr)} ${node.negated ? "NOT IN" : "IN"} (${values})`
    }
    case "Logical": {
      const separator = node.op === "and" ? " AND " : " OR "
      return `(${node.operands.map((operand) => compileExpr(context, operand)).join(separator)})`
    }
    case "Not":
      return `NOT (${compileExpr(context, node.expr)})`
    case "IsNull":
      return `${compileExpr(context, node.expr)} IS ${node.negated ? "NOT NULL" : "NULL"}`
    case "RawExpr":
      return compileRaw(context, node)
  }
}

/**
 * @param context - Active compiler state.
 * @param fields - Ordered output fields.
 * @returns Comma-separated, aliased selection SQL.
 */
const compileSelection = (context: CompileContext, fields: ReadonlyArray<SelectionField>): string =>
  fields
    .map((field) => `${compileExpr(context, field.expr)} AS ${context.dialect.quoteIdent(field.alias)}`)
    .join(", ")

/**
 * @param context - Active compiler state.
 * @param terms - Ordered sort terms.
 * @returns Comma-separated `ORDER BY` body.
 */
const compileOrderBy = (context: CompileContext, terms: ReadonlyArray<OrderByTerm>): string =>
  terms.map((term) => `${compileExpr(context, term.expr)} ${term.direction.toUpperCase()}`).join(", ")

/**
 * @param context - Active compiler state.
 * @param fields - Optional returned fields.
 * @returns A leading-space `RETURNING` clause or an empty string.
 */
const returningClause = (context: CompileContext, fields: ReadonlyArray<SelectionField> | undefined): string =>
  fields && fields.length > 0 ? ` RETURNING ${compileSelection(context, fields)}` : ""

/**
 * @param context - Active compiler state.
 * @param ir - Select representation.
 * @returns Complete select SQL.
 */
const compileSelect = (context: CompileContext, ir: SelectIR): string => {
  let sql = `SELECT ${compileSelection(context, ir.selection)} FROM ${compileSource(context, ir.from)}`
  if (ir.where) sql += ` WHERE ${compileExpr(context, ir.where)}`
  if (ir.orderBy.length > 0) sql += ` ORDER BY ${compileOrderBy(context, ir.orderBy)}`
  if (ir.limit !== undefined) sql += ` LIMIT ${ir.limit}`
  if (ir.offset !== undefined) sql += ` OFFSET ${ir.offset}`
  return sql
}

/**
 * @param context - Active compiler state.
 * @param ir - Insert representation.
 * @returns Complete insert SQL.
 */
const compileInsert = (context: CompileContext, ir: InsertIR): string => {
  const columns = ir.columns.map((column) => context.dialect.quoteIdent(column)).join(", ")
  const rows = ir.rows
    .map((row) => `(${row.map((value) => compileExpr(context, value)).join(", ")})`)
    .join(", ")
  return `INSERT INTO ${compileSource(context, ir.into)} (${columns}) VALUES ${rows}${returningClause(context, ir.returning)}`
}

/**
 * @param context - Active compiler state.
 * @param ir - Update representation.
 * @returns Complete update SQL.
 */
const compileUpdate = (context: CompileContext, ir: UpdateIR): string => {
  const assignments = ir.set
    .map((assignment) =>
      `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`
    )
    .join(", ")
  let sql = `UPDATE ${compileSource(context, ir.table)} SET ${assignments}`
  if (ir.where) sql += ` WHERE ${compileExpr(context, ir.where)}`
  return sql + returningClause(context, ir.returning)
}

/**
 * @param context - Active compiler state.
 * @param ir - Delete representation.
 * @returns Complete delete SQL.
 */
const compileDelete = (context: CompileContext, ir: DeleteIR): string => {
  let sql = `DELETE FROM ${compileSource(context, ir.from)}`
  if (ir.where) sql += ` WHERE ${compileExpr(context, ir.where)}`
  return sql + returningClause(context, ir.returning)
}

/**
 * Compiles runtime query IR for a database dialect.
 *
 * @param ir - Immutable query representation to lower.
 * @param dialect - Backend syntax and capability implementation.
 * @returns SQL text, positional parameter order, and a value-independent cache key.
 */
export const compileQuery = (ir: QueryIR, dialect: Dialect): CompiledQuery => {
  const normalized = normalizeQuery(ir)
  const context: CompileContext = { dialect, params: [] }
  let sql: string
  switch (normalized._tag) {
    case "Select":
      sql = compileSelect(context, normalized)
      break
    case "Insert":
      sql = compileInsert(context, normalized)
      break
    case "Update":
      sql = compileUpdate(context, normalized)
      break
    case "Delete":
      sql = compileDelete(context, normalized)
      break
  }
  // Cache key scopes the compiled shape by dialect id + versioned capability
  // profile + dialect-independent IR hash (spec §15.14). Execution mode and
  // decode mode compose at the plan/handle layer (see execution/plan.ts), not
  // here, so identical SQL shares one server-side prepared statement across modes.
  const cacheKey = `${dialect.id}:${dialect.profileHash}:${queryStructuralHash(normalized)}`
  return { sql, paramOrder: context.params, cacheKey }
}
