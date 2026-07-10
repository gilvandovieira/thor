/**
 * SQLite introspection via `pragma` (spec §16.4).
 *
 * SQLite exposes shape through per-table pragmas rather than a set-based
 * `information_schema`, so this issues `table_info` and `foreign_key_list` for
 * each base table.
 *
 * @module introspect/sqlite
 */
import { Effect } from "effect"
import type { RawRow } from "../execution/driver.js"
import { normalizeAction } from "./assemble.js"
import type {
  DialectIntrospection,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
  IntrospectionQuery
} from "./schema-ir.js"

const TABLES = "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name"

/** @param name - Identifier to escape. @returns Double-quoted SQLite identifier. */
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * Introspect one table via `table_info` and `foreign_key_list`.
 *
 * @param query - Read-only query runner.
 * @param name - Table name.
 * @returns The introspected table.
 */
const introspectTable = (query: IntrospectionQuery, name: string) =>
  Effect.gen(function* () {
    const columnRows = yield* query(`pragma table_info(${quote(name)})`)
    const columns = columnRows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      nullable: Number(row.notnull) === 0,
      default: row.dflt_value == null ? null : String(row.dflt_value)
    }))
    // `pk` is 0 for non-key columns, else the 1-based position in the key.
    const primaryKey = columnRows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => String(row.name))

    const fkRows = yield* query(`pragma foreign_key_list(${quote(name)})`)
    const byId = new Map<number, RawRow[]>()
    for (const row of fkRows) {
      const id = Number(row.id)
      const group = byId.get(id) ?? []
      group.push(row)
      byId.set(id, group)
    }
    const foreignKeys: IntrospectedForeignKey[] = [...byId.values()].map((group) => {
      const ordered = [...group].sort((a, b) => Number(a.seq) - Number(b.seq))
      const first = ordered[0]!
      const onDelete = normalizeAction(first.on_delete)
      const onUpdate = normalizeAction(first.on_update)
      return {
        columns: ordered.map((row) => String(row.from)),
        references: { table: String(first.table), columns: ordered.map((row) => String(row.to)) },
        ...(onDelete ? { onDelete } : {}),
        ...(onUpdate ? { onUpdate } : {})
      }
    })

    // Only explicitly created indexes (origin "c"); "pk"/"u" are constraint-backed.
    const indexListRows = yield* query(`pragma index_list(${quote(name)})`)
    const indexes: IntrospectedIndex[] = []
    for (const indexRow of indexListRows) {
      if (String(indexRow.origin) !== "c") continue
      const indexName = String(indexRow.name)
      const infoRows = yield* query(`pragma index_info(${quote(indexName)})`)
      indexes.push({
        name: indexName,
        columns: [...infoRows].sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((row) => String(row.name)),
        unique: Number(indexRow.unique) === 1
      })
    }

    return { name, columns, primaryKey, foreignKeys, indexes } satisfies IntrospectedTable
  })

/** SQLite introspection strategy. */
export const SQLiteIntrospection: DialectIntrospection = {
  dialect: "sqlite",
  /**
   * @param query - Read-only query runner.
   * @returns The introspected SQLite schema.
   */
  currentSchema: (query) =>
    Effect.gen(function* () {
      const tableRows = yield* query(TABLES)
      const names = tableRows.map((row) => String(row.name))
      const tables = yield* Effect.forEach(names, (name) => introspectTable(query, name))
      return { tables } satisfies IntrospectedSchema
    })
}
