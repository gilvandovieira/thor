/**
 * PostgreSQL DDL compiler and migrator lifecycle SQL.
 *
 * @module postgres/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import type { MigrationOperation } from "../migrate/migration-ir.js"

/**
 * @param name - Identifier to escape.
 * @returns Double-quoted PostgreSQL identifier.
 */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * @param operation - Migration operation to render.
 * @returns PostgreSQL DDL or raw SQL.
 */
export const compilePostgresOperation = (operation: MigrationOperation): string => {
  const quote = quoteIdent
  switch (operation._tag) {
    case "CreateTable": {
      const columns = operation.columns.map((column) => {
        const parts = [
          quote(column.name),
          column.type,
          column.nullable ? "" : "not null",
          column.default ? `default ${column.default}` : ""
        ]
        return "  " + parts.filter(Boolean).join(" ")
      })
      if (operation.primaryKey.length > 0) {
        columns.push(`  primary key (${operation.primaryKey.map(quote).join(", ")})`)
      }
      return `create table ${quote(operation.table)} (\n${columns.join(",\n")}\n);`
    }
    case "DropTable":
      return `drop table ${quote(operation.table)};`
    case "RenameTable":
      return `alter table ${quote(operation.from)} rename to ${quote(operation.to)};`
    case "AddColumn": {
      const column = operation.column
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${column.type}${column.nullable ? "" : " not null"}${column.default ? ` default ${column.default}` : ""};`
    }
    case "DropColumn":
      return `alter table ${quote(operation.table)} drop column ${quote(operation.column)};`
    case "RenameColumn":
      return `alter table ${quote(operation.table)} rename column ${quote(operation.from)} to ${quote(operation.to)};`
    case "AlterColumnType":
      return `alter table ${quote(operation.table)} alter column ${quote(operation.column)} type ${operation.to};`
    case "SetNotNull":
      return `alter table ${quote(operation.table)} alter column ${quote(operation.column)} set not null;`
    case "DropNotNull":
      return `alter table ${quote(operation.table)} alter column ${quote(operation.column)} drop not null;`
    case "RawSql":
      return operation.sql.trim().endsWith(";") ? operation.sql : `${operation.sql};`
  }
}

/** PostgreSQL journal, advisory-lock, transaction, introspection, and DDL strategy. */
export const PostgresMigrations: MigrationDialect = {
  compileOperation: compilePostgresOperation,
  /**
   * @param table - Journal table name.
   * @returns Journal creation DDL.
   */
  ensureJournal: (table) => `create table if not exists ${quoteIdent(table)} (
    id text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null,
    execution_time_ms integer not null
  );`,
  /**
   * @param table - Journal table name.
   * @returns SQL selecting applied migrations.
   */
  readJournal: (table) =>
    `select id, name, checksum, applied_at, execution_time_ms from ${quoteIdent(table)} order by id asc`,
  /**
   * @param table - Journal table name.
   * @returns SQL inserting one journal row.
   */
  insertJournal: (table) =>
    `insert into ${quoteIdent(table)} (id, name, checksum, applied_at, execution_time_ms) values ($1, $2, $3, $4, $5)`,
  /**
   * @param table - Journal table name.
   * @returns SQL deleting one journal row.
   */
  deleteJournal: (table) => `delete from ${quoteIdent(table)} where id = $1`,
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Advisory-lock acquisition statement.
   */
  acquireLock: (key) => ({ sql: "select pg_advisory_lock($1)", params: [key] }),
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Advisory-lock release statement.
   */
  releaseLock: (key) => ({ sql: "select pg_advisory_unlock($1)", params: [key] }),
  transactionalDdl: true,
  beginTransaction: "begin",
  commitTransaction: "commit",
  rollbackTransaction: "rollback",
  listTables:
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
}
