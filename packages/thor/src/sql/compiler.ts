/**
 * Shared runtime-IR compiler used by concrete database dialects.
 *
 * The compiler owns statement structure and parameter ordering. Dialects supply
 * identifier quoting, placeholders, and comparison rendering.
 *
 * @module sql/compiler
 */
import type { CompiledStatement } from "../execution/driver.js"
import type {
  CallIR,
  DeleteIR,
  ExprNode,
  InsertIR,
  OrderByTerm,
  ParamNode,
  QuerySource,
  QueryIR,
  SelectionField,
  SelectIR,
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
 * @param source - Table, subquery, or CTE source.
 * @returns A dialect-quoted table reference.
 */
const compileSource = (context: CompileContext, source: QuerySource): string => {
  if ("_tag" in source && source._tag === "SubquerySource") {
    return `(${compileSelect(context, source.query)}) ${context.dialect.quoteIdent(source.alias)}`
  }
  if ("_tag" in source && source._tag === "CteSource") {
    const name = context.dialect.quoteIdent(source.name)
    return source.alias ? `${name} ${context.dialect.quoteIdent(source.alias)}` : name
  }
  if ("_tag" in source && source._tag === "TableFunctionSource") {
    const name = source.schema
      ? `${context.dialect.quoteIdent(source.schema)}.${context.dialect.quoteIdent(source.name)}`
      : context.dialect.quoteIdent(source.name)
    const args = source.args.map((arg, index) =>
      context.dialect.routineArgument(compileExpr(context, arg), source.argTypes[index]!)
    ).join(", ")
    const columns = source.columns.length > 0
      ? `(${source.columns.map((column) => context.dialect.quoteIdent(column)).join(", ")})`
      : ""
    return `${name}(${args}) ${context.dialect.quoteIdent(source.alias)}${columns}`
  }
  const name = context.dialect.quoteIdent(source.name)
  return source.alias ? `${name} ${context.dialect.quoteIdent(source.alias)}` : name
}

/**
 * Compiles structural raw-expression fragments for the active dialect.
 *
 * @param context - Active compiler state.
 * @param node - Trusted raw expression node.
 * @returns Raw SQL with dialect placeholders and identifier quoting.
 */
const compileRaw = (context: CompileContext, node: Extract<ExprNode, { readonly _tag: "RawExpr" }>): string => {
  let sql = ""
  for (let index = 0; index < node.strings.length; index++) {
    sql += node.strings[index]
    const value = node.values[index]
    if (!value) continue
    switch (value._tag) {
      case "Param":
        context.params.push(value)
        sql += context.dialect.placeholder(context.params.length)
        break
      case "ColumnRef":
        sql += value.table
          ? `${context.dialect.quoteIdent(value.table)}.${context.dialect.quoteIdent(value.column)}`
          : context.dialect.quoteIdent(value.column)
        break
      case "UnsafeSql":
        sql += value.sql
        break
    }
  }
  return sql
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
    case "ScalarSubquery":
      return `(${compileSelect(context, node.query)})`
    case "Exists":
      return `${node.negated ? "NOT " : ""}EXISTS (${compileSelect(context, node.query)})`
    case "InSubquery":
      return `${compileExpr(context, node.expr)} ${node.negated ? "NOT IN" : "IN"} (${compileSelect(context, node.query)})`
    case "FunctionCall": {
      const name = node.declared
        ? node.schema
          ? `${context.dialect.quoteIdent(node.schema)}.${context.dialect.quoteIdent(node.name)}`
          : context.dialect.quoteIdent(node.name)
        : /^[a-z_][a-z0-9_]*$/i.test(node.name)
          ? node.name.toUpperCase()
          : context.dialect.quoteIdent(node.name)
      const args = node.star ? "*" : node.args.map((arg) => compileExpr(context, arg)).join(", ")
      return `${name}(${args})`
    }
    case "WindowFunction": {
      const clauses: string[] = []
      if (node.partitionBy.length > 0) {
        clauses.push(`PARTITION BY ${node.partitionBy.map((item) => compileExpr(context, item)).join(", ")}`)
      }
      if (node.orderBy.length > 0) clauses.push(`ORDER BY ${compileOrderBy(context, node.orderBy)}`)
      if (node.frame) clauses.push(node.frame)
      return `${compileExpr(context, node.function)} OVER (${clauses.join(" ")})`
    }
    case "ExcludedRef":
      return context.dialect.excluded(node.column)
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
  let prefix = ""
  if ((ir.ctes?.length ?? 0) > 0) {
    const recursive = ir.ctes!.some((cte) => cte.recursive) ? " RECURSIVE" : ""
    const definitions = ir.ctes!
      .map((cte) => `${context.dialect.quoteIdent(cte.name)} AS (${compileSelect(context, cte.query)})`)
      .join(", ")
    prefix = `WITH${recursive} ${definitions} `
  }

  let sql = `SELECT${ir.distinct ? " DISTINCT" : ""} ${compileSelection(context, ir.selection)} FROM ${compileSource(context, ir.from)}`
  for (const join of ir.joins ?? []) {
    const keyword = join.type === "inner"
      ? "INNER JOIN"
      : join.type === "left"
        ? "LEFT JOIN"
        : join.type === "right"
          ? "RIGHT JOIN"
          : join.type === "full"
            ? "FULL JOIN"
            : "CROSS JOIN"
    sql += ` ${keyword}${join.lateral ? " LATERAL" : ""} ${compileSource(context, join.source)}`
    if (join.on) sql += ` ON ${compileExpr(context, join.on)}`
  }
  if (ir.where) sql += ` WHERE ${compileExpr(context, ir.where)}`
  if ((ir.groupBy?.length ?? 0) > 0) {
    sql += ` GROUP BY ${ir.groupBy!.map((item) => compileExpr(context, item)).join(", ")}`
  }
  if (ir.having) sql += ` HAVING ${compileExpr(context, ir.having)}`
  for (const operation of ir.setOperations ?? []) {
    sql += ` ${operation.type.toUpperCase()}${operation.all ? " ALL" : ""} ${compileSelect(context, operation.query)}`
  }
  if (ir.orderBy.length > 0) sql += ` ORDER BY ${compileOrderBy(context, ir.orderBy)}`
  if (ir.limit !== undefined) sql += ` LIMIT ${ir.limit}`
  if (ir.offset !== undefined) sql += ` OFFSET ${ir.offset}`
  return prefix + sql
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
  let sql = `INSERT INTO ${compileSource(context, ir.into)} (${columns}) VALUES ${rows}`
  if (ir.conflict?.kind === "onConflict") {
    const target = ir.conflict.target.length > 0
      ? ` (${ir.conflict.target.map((column) => context.dialect.quoteIdent(column)).join(", ")})`
      : ""
    sql += ` ON CONFLICT${target} DO ${ir.conflict.action === "nothing"
      ? "NOTHING"
      : `UPDATE SET ${ir.conflict.set.map((assignment) =>
          `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`
        ).join(", ")}`}`
  } else if (ir.conflict?.kind === "onDuplicateKey") {
    sql += ` ON DUPLICATE KEY UPDATE ${ir.conflict.set.map((assignment) =>
      `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`
    ).join(", ")}`
  }
  return sql + returningClause(context, ir.returning)
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
 * @param context - Active compiler state.
 * @param ir - Procedure-call representation.
 * @returns Complete `CALL` statement.
 */
const compileCall = (context: CompileContext, ir: CallIR): string => {
  const name = ir.schema
    ? `${context.dialect.quoteIdent(ir.schema)}.${context.dialect.quoteIdent(ir.procedure)}`
    : context.dialect.quoteIdent(ir.procedure)
  return `CALL ${name}(${ir.args.map((arg) => compileExpr(context, arg)).join(", ")})`
}

/**
 * Compiles runtime query IR for a database dialect.
 *
 * @param ir - Immutable query representation to lower.
 * @param dialect - Backend syntax and capability implementation.
 * @returns SQL text, positional parameter order, and a value-independent cache key.
 */
export const compileQuery = (ir: QueryIR, dialect: Dialect): CompiledStatement => {
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
    case "Call":
      sql = compileCall(context, normalized)
      break
  }
  // Cache key scopes the compiled shape by dialect id + versioned capability
  // profile + dialect-independent IR hash (spec §15.14). Execution mode and
  // decode mode compose at the plan/handle layer (see execution/plan.ts), not
  // here, so identical SQL shares one server-side prepared statement across modes.
  const cacheKey = `${dialect.id}:${dialect.profileHash}:${queryStructuralHash(normalized)}`
  return { sql, paramOrder: context.params, cacheKey }
}
