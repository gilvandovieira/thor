/**
 * PostgreSQL introspection via `information_schema` (spec §16.4).
 *
 * @module introspect/postgres
 */
import { Effect } from "effect"
import { type RawColumn, type RawForeignKey, type RawIndex, type RawPrimaryKey, assembleSchema, normalizeAction } from "./assemble.js"
import type { DialectIntrospection } from "./schema-ir.js"

const TABLES =
  "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"

const COLUMNS =
  "select table_name, column_name, data_type, is_nullable, column_default " +
  "from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position"

const PRIMARY_KEYS =
  "select tc.table_name, kcu.column_name from information_schema.table_constraints tc " +
  "join information_schema.key_column_usage kcu " +
  "on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema " +
  "where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' " +
  "order by tc.table_name, kcu.ordinal_position"

const FOREIGN_KEYS =
  "select tc.table_name, tc.constraint_name, kcu.column_name, " +
  "ccu.table_name as foreign_table, ccu.column_name as foreign_column, rc.delete_rule, rc.update_rule " +
  "from information_schema.table_constraints tc " +
  "join information_schema.key_column_usage kcu " +
  "on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema " +
  "join information_schema.referential_constraints rc " +
  "on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.constraint_schema " +
  "join information_schema.constraint_column_usage ccu " +
  "on ccu.constraint_name = rc.unique_constraint_name and ccu.constraint_schema = rc.unique_constraint_schema " +
  "where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public' " +
  "order by tc.constraint_name, kcu.ordinal_position"

// Secondary indexes only: exclude the primary key and any index backing a
// constraint (unique/exclusion), so this mirrors the schema `indexes` option.
const INDEXES =
  "select t.relname as table_name, i.relname as index_name, a.attname as column_name, ix.indisunique as is_unique " +
  "from pg_index ix " +
  "join pg_class i on i.oid = ix.indexrelid " +
  "join pg_class t on t.oid = ix.indrelid " +
  "join pg_namespace n on n.oid = t.relnamespace " +
  "join lateral unnest(ix.indkey) with ordinality as k(attnum, ord) on true " +
  "join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum " +
  "where n.nspname = 'public' and not ix.indisprimary " +
  "and not exists (select 1 from pg_constraint c where c.conindid = ix.indexrelid) " +
  "order by t.relname, i.relname, k.ord"

/** PostgreSQL introspection strategy. */
export const PostgresIntrospection: DialectIntrospection = {
  dialect: "postgres",
  /**
   * @param query - Read-only query runner.
   * @returns The introspected PostgreSQL schema.
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
        type: String(row.data_type),
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
        unique: row.is_unique === true || row.is_unique === "t" || row.is_unique === 1
      }))

      return assembleSchema(tableRows.map((row) => String(row.table_name)), columns, primaryKeys, foreignKeys, indexes)
    })
}
