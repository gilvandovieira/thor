/**
 * Raw SQL expression escape hatch. Values interpolated as `${param(...)}` stay
 * parameterized; everything else is treated as trusted SQL text.
 *
 * @module sql/raw
 */
import type { ExprNode, ParamNode, RawExprNode } from "../ir/query-ir.js"
import { isColumn } from "./expressions.js"

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a parameter node.
 */
const isParam = (value: unknown): value is ParamNode =>
  typeof value === "object" && value !== null && (value as { _tag?: string })._tag === "Param"

/**
 * Tagged template producing a raw expression node. Interpolated params/columns
 * become placeholders; strings/numbers are inlined as trusted text.
 *
 * @param strings - Static template chunks supplied by the tag call.
 * @param values - Interpolated parameters, columns, or trusted SQL values.
 * @returns A raw expression node with separately tracked parameters.
 * @example
 * ```ts
 * sql`lower(${users.email}) = lower(${param("email", Schema.String)})`
 * ```
 */
export const rawExpr = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): RawExprNode => {
  const params: ParamNode[] = []
  let sql = ""
  strings.forEach((chunk, i) => {
    sql += chunk
    if (i < values.length) {
      const value = values[i]
      if (isParam(value)) {
        params.push(value)
        sql += `$${params.length}`
      } else if (isColumn(value)) {
        sql += `"${value.def.table}"."${value.def.name}"`
      } else {
        sql += String(value)
      }
    }
  })
  return { _tag: "RawExpr", sql, params }
}

/** Re-export for symmetry with predicate helpers. */
export type { ExprNode }
