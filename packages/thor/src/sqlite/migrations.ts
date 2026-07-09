/**
 * SQLite DDL compiler and migrator lifecycle SQL.
 *
 * @module sqlite/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import type { ColumnSpec, MigrationOperation } from "../migrate/migration-ir.js"

/**
 * @param name - Identifier to escape.
 * @returns Double-quoted SQLite identifier.
 */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * @param type - Logical column type.
 * @returns SQLite type-affinity declaration.
 */
const sqliteType = (type: ColumnSpec["type"]): string => {
  switch (type) {
    case "integer":
    case "bigint":
    case "boolean":
      return "integer"
    case "real":
    case "double precision":
      return "real"
    case "uuid":
    case "text":
    case "varchar":
    case "timestamptz":
    case "timestamp":
    case "date":
    case "jsonb":
    case "json":
      return "text"
  }
}

const UUID_DEFAULT = `(lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
))`

/**
 * @param value - Logical default SQL.
 * @returns SQLite-compatible default expression.
 */
const sqliteDefault = (value: string): string => {
  if (value === "now()") return "CURRENT_TIMESTAMP"
  if (value === "gen_random_uuid()") return UUID_DEFAULT
  return value
}

/**
 * @param operation - Unsupported alteration.
 * @returns Never; this function always throws.
 *
 * @throws {Error} Always, because a table rebuild is required.
 */
const unsupportedAlter = (operation: MigrationOperation): never => {
  throw new Error(`SQLite migration operation "${operation._tag}" requires a table rebuild`)
}

/**
 * @param operation - Migration operation to render.
 * @returns SQLite DDL or raw SQL.
 * @throws {Error} When an alteration requires an unimplemented table rebuild.
 */
export const compileSQLiteOperation = (operation: MigrationOperation): string => {
  const quote = quoteIdent
  switch (operation._tag) {
    case "CreateTable": {
      const columns = operation.columns.map((column) => {
        const parts = [
          quote(column.name),
          sqliteType(column.type),
          column.nullable ? "" : "not null",
          column.default ? `default ${sqliteDefault(column.default)}` : ""
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
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${sqliteType(column.type)}${column.nullable ? "" : " not null"}${column.default ? ` default ${sqliteDefault(column.default)}` : ""};`
    }
    case "DropColumn":
      return `alter table ${quote(operation.table)} drop column ${quote(operation.column)};`
    case "RenameColumn":
      return `alter table ${quote(operation.table)} rename column ${quote(operation.from)} to ${quote(operation.to)};`
    case "AlterColumnType":
    case "SetNotNull":
    case "DropNotNull":
      return unsupportedAlter(operation)
    case "RawSql":
      return operation.sql.trim().endsWith(";") ? operation.sql : `${operation.sql};`
  }
}

/** SQLite journal, transaction, introspection, and DDL strategy. */
export const SQLiteMigrations: MigrationDialect = {
  compileOperation: compileSQLiteOperation,
  /**
   * @param table - Journal table name.
   * @returns Journal creation DDL.
   */
  ensureJournal: (table) => `create table if not exists ${quoteIdent(table)} (
    id text primary key,
    name text not null,
    checksum text not null,
    applied_at text not null,
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
    `insert into ${quoteIdent(table)} (id, name, checksum, applied_at, execution_time_ms) values (?, ?, ?, ?, ?)`,
  /**
   * @param table - Journal table name.
   * @returns SQL deleting one journal row.
   */
  deleteJournal: (table) => `delete from ${quoteIdent(table)} where id = ?`,
  /** @returns No lock statement; SQLite write transactions serialize migrations. */
  acquireLock: () => undefined,
  /** @returns No unlock statement; transaction completion releases the lock. */
  releaseLock: () => undefined,
  transactionalDdl: true,
  beginTransaction: "begin immediate",
  commitTransaction: "commit",
  rollbackTransaction: "rollback",
  listTables:
    "select name as table_name from sqlite_schema where type = 'table' and name not like 'sqlite_%'"
}
