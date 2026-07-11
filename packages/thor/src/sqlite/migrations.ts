/**
 * SQLite DDL compiler and migrator lifecycle SQL.
 *
 * @module sqlite/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import type { ColumnDefault, ColumnSpec, DefaultLiteral, MigrationOperation } from "../migrate/migration-ir.js"

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
const literal = (value: DefaultLiteral): string => {
  if (value === null) return "null"
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite DDL default")
  return String(value)
}

/** @param value - Dialect-neutral default. @returns SQLite default SQL. */
const sqliteDefault = (value: ColumnDefault): string => {
  switch (value.kind) {
    case "value":
      return literal(value.value)
    case "sql":
      return value.sql
    case "now":
      return "CURRENT_TIMESTAMP"
    case "random":
      return UUID_DEFAULT
  }
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
 * SQLite forbids several column shapes in `ALTER TABLE ... ADD COLUMN` that are
 * legal in `CREATE TABLE` (no UNIQUE, no STORED generated column, only constant
 * defaults, and `NOT NULL` only with a non-null constant default). Reject them
 * up front so the migrator surfaces a tagged failure instead of emitting SQL the
 * driver rejects at execution time.
 *
 * @param column - Column being added to an existing table.
 * @returns Nothing; returns normally when SQLite can add the column in place.
 * @throws {Error} When the column requires a table rebuild.
 */
const assertAddColumnSupported = (column: ColumnSpec): void => {
  const rebuild = (reason: string): never => {
    throw new Error(`SQLite cannot add column "${column.name}" ${reason}; a table rebuild is required`)
  }
  if (column.unique) rebuild("with a UNIQUE constraint")
  if (column.generated?.stored) rebuild("as a STORED generated column")
  if (column.default && column.default.kind !== "value") rebuild("with a non-constant default expression")
  if (column.default?.kind === "value" && column.default.value === null && !column.nullable) {
    rebuild("as NOT NULL with a NULL default")
  }
  if (!column.nullable && !column.generated && !column.default) rebuild("as NOT NULL without a default value")
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
          column.generated
            ? `generated always as (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}`
            : "",
          column.nullable ? "" : "not null",
          column.unique ? "unique" : "",
          column.default ? `default ${sqliteDefault(column.default)}` : ""
        ]
        return `  ${parts.filter(Boolean).join(" ")}`
      })
      if (operation.primaryKey.length > 0) {
        columns.push(`  primary key (${operation.primaryKey.map(quote).join(", ")})`)
      }
      for (const constraint of operation.uniqueConstraints ?? []) {
        columns.push(
          `  ${constraint.name ? `constraint ${quote(constraint.name)} ` : ""}unique (${constraint.columns.map(quote).join(", ")})`
        )
      }
      for (const check of operation.checks ?? []) {
        columns.push(`  ${check.name ? `constraint ${quote(check.name)} ` : ""}check (${check.expression})`)
      }
      for (const foreignKey of operation.foreignKeys ?? []) {
        columns.push(
          `  ${foreignKey.name ? `constraint ${quote(foreignKey.name)} ` : ""}foreign key (${foreignKey.columns.map(quote).join(", ")}) references ${quote(foreignKey.references.table)} (${foreignKey.references.columns.map(quote).join(", ")})${foreignKey.onDelete ? ` on delete ${foreignKey.onDelete}` : ""}${foreignKey.onUpdate ? ` on update ${foreignKey.onUpdate}` : ""}`
        )
      }
      const create = `create table ${quote(operation.table)} (\n${columns.join(",\n")}\n);`
      const indexes = (operation.indexes ?? []).map(
        (index) =>
          `create ${index.unique ? "unique " : ""}index ${quote(index.name)} on ${quote(operation.table)} (${index.columns.map(quote).join(", ")});`
      )
      return [create, ...indexes].join("\n")
    }
    case "DropTable":
      return `drop table ${quote(operation.table)};`
    case "RenameTable":
      return `alter table ${quote(operation.from)} rename to ${quote(operation.to)};`
    case "AddColumn": {
      const column = operation.column
      assertAddColumnSupported(column)
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${sqliteType(column.type)}${column.generated ? ` generated always as (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}` : ""}${column.nullable ? "" : " not null"}${column.unique ? " unique" : ""}${column.default ? ` default ${sqliteDefault(column.default)}` : ""};`
    }
    case "DropColumn":
      return `alter table ${quote(operation.table)} drop column ${quote(operation.column)};`
    case "RenameColumn":
      return `alter table ${quote(operation.table)} rename column ${quote(operation.from)} to ${quote(operation.to)};`
    case "AlterColumnType":
    case "SetNotNull":
    case "DropNotNull":
      return unsupportedAlter(operation)
    case "CreateRoutine":
    case "DropRoutine":
      throw new Error(`SQLite does not support stored ${operation.routine}s`)
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
  listTables: "select name as table_name from sqlite_schema where type = 'table' and name not like 'sqlite_%'"
}
