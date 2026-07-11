/**
 * MySQL introspection via `information_schema` (spec §16.4).
 *
 * MySQL's `key_column_usage` carries the referenced table/column inline, so
 * foreign keys need no `constraint_column_usage` join.
 *
 * @module introspect/mysql
 */
import { Effect } from "effect"
import {
  type RawColumn,
  type RawForeignKey,
  type RawIndex,
  type RawPrimaryKey,
  assembleSchema,
  normalizeAction
} from "./assemble.js"
import type { DialectIntrospection } from "./schema-ir.js"

const TABLES =
  "select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE' order by table_name"

const COLUMNS =
  "select table_name, column_name, column_type, is_nullable, column_default " +
  "from information_schema.columns where table_schema = database() order by table_name, ordinal_position"

const PRIMARY_KEYS =
  "select table_name, column_name from information_schema.key_column_usage " +
  "where table_schema = database() and constraint_name = 'PRIMARY' order by table_name, ordinal_position"

const FOREIGN_KEYS =
  "select k.table_name, k.constraint_name, k.column_name, " +
  "k.referenced_table_name as foreign_table, k.referenced_column_name as foreign_column, r.delete_rule, r.update_rule " +
  "from information_schema.key_column_usage k " +
  "join information_schema.referential_constraints r " +
  "on r.constraint_name = k.constraint_name and r.constraint_schema = k.constraint_schema " +
  "where k.table_schema = database() and k.referenced_table_name is not null " +
  "order by k.constraint_name, k.ordinal_position"

// Non-primary indexes from information_schema.statistics. Note: MySQL also lists
// indexes that back unique/foreign-key constraints here.
const INDEXES =
  "select table_name, index_name, column_name, non_unique " +
  "from information_schema.statistics " +
  "where table_schema = database() and index_name <> 'PRIMARY' " +
  "order by table_name, index_name, seq_in_index"

/** MySQL introspection strategy. */
export const MySQLIntrospection: DialectIntrospection = {
  dialect: "mysql",
  /**
   * @param query - Read-only query runner.
   * @returns The introspected MySQL schema.
   */
  currentSchema: (query) =>
    Effect.gen(function* () {
      const tableRows = yield* query(TABLES)
      const columnRows = yield* query(COLUMNS)
      const pkRows = yield* query(PRIMARY_KEYS)
      const fkRows = yield* query(FOREIGN_KEYS)
      const indexRows = yield* query(INDEXES)

      const columns: RawColumn[] = columnRows.map((row) => ({
        table: String(row.table_name),
        name: String(row.column_name),
        type: String(row.column_type),
        nullable: String(row.is_nullable).toUpperCase() === "YES",
        default: row.column_default == null ? null : String(row.column_default)
      }))
      const primaryKeys: RawPrimaryKey[] = pkRows.map((row) => ({
        table: String(row.table_name),
        column: String(row.column_name)
      }))
      const foreignKeys: RawForeignKey[] = fkRows.map((row) => {
        const onDelete = normalizeAction(row.delete_rule)
        const onUpdate = normalizeAction(row.update_rule)
        return {
          table: String(row.table_name),
          constraint: String(row.constraint_name),
          column: String(row.column_name),
          referencedTable: String(row.foreign_table),
          referencedColumn: String(row.foreign_column),
          ...(onDelete ? { onDelete } : {}),
          ...(onUpdate ? { onUpdate } : {})
        }
      })

      const indexes: RawIndex[] = indexRows.map((row) => ({
        table: String(row.table_name),
        name: String(row.index_name),
        column: String(row.column_name),
        unique: Number(row.non_unique) === 0
      }))

      return assembleSchema(
        tableRows.map((row) => String(row.table_name)),
        columns,
        primaryKeys,
        foreignKeys,
        indexes
      )
    })
}
