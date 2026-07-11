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
  UpdateIR,
  WindowFrameBoundaryNode,
  WindowFrameNode
} from "../ir/query-ir.js"
import type { Dialect } from "../dialect.js"
import { queryStructuralHash } from "../ir/structural-hash.js"
import { normalizeQuery } from "../ir/normalize.js"
import { CompileError } from "../errors/index.js"

/**
 * Guards against IR shapes that would render syntactically invalid SQL (an empty
 * selection, column list, or `SET`/conflict-`SET` clause). Execution already
 * blocks these via structural guards, but `toSql()` compiles directly — this
 * ensures the compiler itself never emits malformed SQL from a public-builder
 * state (spec §8, Finding 9).
 *
 * @param ok - Whether the clause is non-empty.
 * @param clause - Human-readable clause name for the error.
 * @returns Nothing; throws when the clause is empty.
 * @throws {CompileError} When `ok` is false.
 */
const requireNonEmpty = (ok: boolean, clause: string): void => {
  if (!ok) throw new CompileError({ message: `Cannot compile a query with an empty ${clause}` })
}

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
    const args = source.args
      .map((arg, index) => context.dialect.routineArgument(compileExpr(context, arg), source.argTypes[index]!))
      .join(", ")
    const columns =
      source.columns.length > 0
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

/** @param boundary - Structured window-frame boundary. @returns SQL boundary syntax. */
const compileFrameBoundary = (boundary: WindowFrameBoundaryNode): string => {
  switch (boundary._tag) {
    case "UnboundedPreceding":
      return "UNBOUNDED PRECEDING"
    case "Preceding":
      return `${boundary.offset} PRECEDING`
    case "CurrentRow":
      return "CURRENT ROW"
    case "Following":
      return `${boundary.offset} FOLLOWING`
    case "UnboundedFollowing":
      return "UNBOUNDED FOLLOWING"
  }
}

/** @param frame - Validated structured window frame. @returns SQL frame syntax. */
const compileWindowFrame = (frame: WindowFrameNode): string =>
  `${frame.unit.toUpperCase()} BETWEEN ${compileFrameBoundary(frame.start)} AND ${compileFrameBoundary(frame.end)}`

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
      return context.dialect.comparison(compileExpr(context, node.left), node.op, compileExpr(context, node.right))
    case "InList": {
      // Compile in textual SQL order (expr before the list): `context.params` is
      // positional, so for `?`-placeholder dialects (SQLite/MySQL) the push order
      // MUST match the emitted order or values bind to the wrong placeholders.
      const expr = compileExpr(context, node.expr)
      const values = node.values.map((value) => compileExpr(context, value)).join(", ")
      return `${expr} ${node.negated ? "NOT IN" : "IN"} (${values})`
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
      // Compile the function (and its args) before the OVER clauses to keep the
      // positional param push order aligned with the emitted `fn(...) OVER (...)`
      // text — otherwise partition/order params bind to the function's `?`s on
      // SQLite/MySQL.
      const fn = compileExpr(context, node.function)
      const clauses: string[] = []
      if (node.partitionBy.length > 0) {
        clauses.push(`PARTITION BY ${node.partitionBy.map((item) => compileExpr(context, item)).join(", ")}`)
      }
      if (node.orderBy.length > 0) clauses.push(`ORDER BY ${compileOrderBy(context, node.orderBy)}`)
      if (node.frame) clauses.push(node.frame._tag === "UnsafeSql" ? node.frame.sql : compileWindowFrame(node.frame))
      return `${fn} OVER (${clauses.join(" ")})`
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
  fields.map((field) => `${compileExpr(context, field.expr)} AS ${context.dialect.quoteIdent(field.alias)}`).join(", ")

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
    const definitions = ir
      .ctes!.map((cte) => `${context.dialect.quoteIdent(cte.name)} AS (${compileSelect(context, cte.query)})`)
      .join(", ")
    prefix = `WITH${recursive} ${definitions} `
  }

  requireNonEmpty(ir.selection.length > 0, "selection")
  let sql = `SELECT${ir.distinct ? " DISTINCT" : ""} ${compileSelection(context, ir.selection)} FROM ${compileSource(context, ir.from)}`
  for (const join of ir.joins ?? []) {
    const keyword =
      join.type === "inner"
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
  sql += paginationClause(context.dialect.id, ir.limit, ir.offset)
  return prefix + sql
}

/**
 * Renders the trailing `LIMIT`/`OFFSET` clause. SQLite and MySQL reject a bare
 * `OFFSET n` with no `LIMIT`, so when only an offset is present they emit an
 * explicit unbounded limit (`LIMIT -1` / the 64-bit max); PostgreSQL allows a
 * standalone `OFFSET` (Finding 13).
 *
 * @param dialectId - Active dialect id.
 * @param limit - Row limit, if any.
 * @param offset - Row offset, if any.
 * @returns A leading-space pagination clause, or an empty string.
 */
const paginationClause = (dialectId: string, limit: number | undefined, offset: number | undefined): string => {
  if (limit !== undefined) {
    return offset !== undefined ? ` LIMIT ${limit} OFFSET ${offset}` : ` LIMIT ${limit}`
  }
  if (offset === undefined) return ""
  if (dialectId === "sqlite") return ` LIMIT -1 OFFSET ${offset}`
  if (dialectId === "mysql") return ` LIMIT 18446744073709551615 OFFSET ${offset}`
  return ` OFFSET ${offset}`
}

/**
 * @param context - Active compiler state.
 * @param ir - Insert representation.
 * @returns Complete insert SQL.
 */
const compileInsert = (context: CompileContext, ir: InsertIR): string => {
  requireNonEmpty(ir.columns.length > 0, "insert column list")
  requireNonEmpty(ir.rows.length > 0, "insert row list")
  const rendersConflictSet =
    (ir.conflict?.kind === "onConflict" && ir.conflict.action === "update") || ir.conflict?.kind === "onDuplicateKey"
  if (rendersConflictSet) {
    requireNonEmpty(ir.conflict.set.length > 0, "conflict update assignment list")
  }
  const columns = ir.columns.map((column) => context.dialect.quoteIdent(column)).join(", ")
  const rows = ir.rows.map((row) => `(${row.map((value) => compileExpr(context, value)).join(", ")})`).join(", ")
  let sql = `INSERT INTO ${compileSource(context, ir.into)} (${columns}) VALUES ${rows}`
  if (ir.conflict?.kind === "onConflict") {
    const target =
      ir.conflict.target.length > 0
        ? ` (${ir.conflict.target.map((column) => context.dialect.quoteIdent(column)).join(", ")})`
        : ""
    sql += ` ON CONFLICT${target} DO ${
      ir.conflict.action === "nothing"
        ? "NOTHING"
        : `UPDATE SET ${ir.conflict.set
            .map(
              (assignment) =>
                `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`
            )
            .join(", ")}`
    }`
  } else if (ir.conflict?.kind === "onDuplicateKey") {
    sql += ` ON DUPLICATE KEY UPDATE ${ir.conflict.set
      .map(
        (assignment) => `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`
      )
      .join(", ")}`
  }
  return sql + returningClause(context, ir.returning)
}

/**
 * @param context - Active compiler state.
 * @param ir - Update representation.
 * @returns Complete update SQL.
 */
const compileUpdate = (context: CompileContext, ir: UpdateIR): string => {
  requireNonEmpty(ir.set.length > 0, "update SET clause")
  const assignments = ir.set
    .map((assignment) => `${context.dialect.quoteIdent(assignment.column)} = ${compileExpr(context, assignment.value)}`)
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
