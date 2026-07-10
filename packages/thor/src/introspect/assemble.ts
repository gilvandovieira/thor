/**
 * Shared assembly of introspected tables from normalized row sets.
 *
 * The `information_schema`-based dialects (PostgreSQL, MySQL) each issue a handful
 * of set-based queries, map the dialect-specific rows into the normalized shapes
 * below, and hand them here. Grouping columns/keys by table is dialect-neutral, so
 * it lives once.
 *
 * @module introspect/assemble
 */
import type { IntrospectedForeignKey, IntrospectedSchema, IntrospectedTable } from "./schema-ir.js"

/** A normalized column row. */
export interface RawColumn {
  readonly table: string
  readonly name: string
  readonly type: string
  readonly nullable: boolean
  readonly default: string | null
}

/** A normalized primary-key member row, in key order. */
export interface RawPrimaryKey {
  readonly table: string
  readonly column: string
}

/** A normalized foreign-key member row, in key order. */
export interface RawForeignKey {
  readonly table: string
  readonly constraint: string
  readonly column: string
  readonly referencedTable: string
  readonly referencedColumn: string
  readonly onDelete?: string
  readonly onUpdate?: string
}

/**
 * Group normalized rows into an {@link IntrospectedSchema}.
 *
 * @param tableNames - Base table names in the desired order.
 * @param columns - Column rows in `(table, ordinal)` order.
 * @param primaryKeys - Primary-key member rows in key order.
 * @param foreignKeys - Foreign-key member rows in `(constraint, ordinal)` order.
 * @returns The assembled schema.
 */
export const assembleSchema = (
  tableNames: ReadonlyArray<string>,
  columns: ReadonlyArray<RawColumn>,
  primaryKeys: ReadonlyArray<RawPrimaryKey>,
  foreignKeys: ReadonlyArray<RawForeignKey>
): IntrospectedSchema => {
  const tables: IntrospectedTable[] = tableNames.map((name) => {
    const tableColumns = columns
      .filter((column) => column.table === name)
      .map((column) => ({ name: column.name, type: column.type, nullable: column.nullable, default: column.default }))

    const primaryKey = primaryKeys.filter((key) => key.table === name).map((key) => key.column)

    // Group this table's foreign-key rows by constraint, preserving key order.
    const byConstraint = new Map<string, RawForeignKey[]>()
    for (const row of foreignKeys) {
      if (row.table !== name) continue
      const group = byConstraint.get(row.constraint) ?? []
      group.push(row)
      byConstraint.set(row.constraint, group)
    }
    const tableForeignKeys: IntrospectedForeignKey[] = [...byConstraint.values()].map((group) => {
      const first = group[0]!
      return {
        columns: group.map((row) => row.column),
        references: { table: first.referencedTable, columns: group.map((row) => row.referencedColumn) },
        ...(first.onDelete ? { onDelete: first.onDelete } : {}),
        ...(first.onUpdate ? { onUpdate: first.onUpdate } : {})
      }
    })

    return { name, columns: tableColumns, primaryKey, foreignKeys: tableForeignKeys }
  })

  return { tables }
}

/**
 * Normalize a database referential-action string (e.g. `CASCADE`, `NO ACTION`) to
 * Thor's lower-case form, dropping the implicit `no action` default.
 *
 * @param action - Raw action text, or nullish.
 * @returns The lower-cased action, or `undefined` for none / `no action`.
 */
export const normalizeAction = (action: unknown): string | undefined => {
  if (action == null) return undefined
  const lowered = String(action).toLowerCase()
  return lowered === "no action" || lowered === "" ? undefined : lowered
}
