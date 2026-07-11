/**
 * Raw SQL expression escape hatch. Parameters and identifiers stay structural
 * until dialect compilation; dynamic text requires an explicit unsafe brand.
 *
 * @module sql/raw
 */
import type { AnyColumn } from "../schema/column.js"
import type { ParamNode, RawExprInterpolation, RawExprNode, UnsafeSqlNode } from "../ir/query-ir.js"
import { createUnsafeSqlNode, isUnsafeSqlNode } from "../ir/unsafe-sql.js"
import { SqlInputBrand, columnRef, isColumn } from "./expressions.js"

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a parameter node produced by `param(...)` (brand required).
 */
const isParam = (value: unknown): value is ParamNode =>
  typeof value === "object" && value !== null && (value as { _tag?: string })._tag === "Param" && SqlInputBrand in value

/**
 * Marks dynamic text for deliberate, unescaped inclusion in SQL.
 *
 * @param sql - Trusted SQL syntax or identifier text controlled by the application.
 * @returns An explicitly unsafe structural SQL fragment.
 * @remarks Never pass request data or other untrusted input to this function.
 */
export const unsafeSql = (sql: string): UnsafeSqlNode => createUnsafeSqlNode(sql)

/** Values accepted inside a raw SQL tagged template. */
export type RawInterpolation = ParamNode | AnyColumn | UnsafeSqlNode

/**
 * Tagged template producing a raw expression node. Interpolated parameters and
 * columns are compiled by the active dialect; dynamic SQL text must be wrapped
 * with `unsafeSql`.
 *
 * @param strings - Static template chunks supplied by the tag call.
 * @param values - Interpolated parameters, columns, or trusted SQL values.
 * @returns A raw expression node with separately tracked parameters.
 * @example
 * ```ts
 * sql`lower(${users.email}) = lower(${param("email", Schema.String)})`
 * ```
 */
export const rawExpr = (strings: TemplateStringsArray, ...values: ReadonlyArray<RawInterpolation>): RawExprNode => ({
  _tag: "RawExpr",
  strings: [...strings],
  values: values.map((value): RawExprInterpolation => {
    if (isParam(value)) return value
    if (isColumn(value)) return columnRef(value)
    if (isUnsafeSqlNode(value)) return value
    throw new TypeError("Raw SQL interpolation accepts only param(...), columns, or unsafeSql(...)")
  })
})
