/**
 * PostgreSQL DDL compiler and migrator lifecycle SQL.
 *
 * @module postgres/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import type { MigrationOperation } from "../migrate/migration-ir.js"
import type { ColumnDefault, DefaultLiteral } from "../migrate/migration-ir.js"

/**
 * @param name - Identifier to escape.
 * @returns Double-quoted PostgreSQL identifier.
 */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** @param value - Typed default literal. @returns PostgreSQL literal SQL. */
const literal = (value: DefaultLiteral): string => {
  if (value === null) return "null"
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite DDL default")
  return String(value)
}

/** @param value - Dialect-neutral default. @returns PostgreSQL default SQL. */
const defaultSql = (value: ColumnDefault): string => {
  switch (value.kind) {
    case "value": return literal(value.value)
    case "sql": return value.sql
    case "now": return "now()"
    case "random": return "gen_random_uuid()"
  }
}

/**
 * @param operation - Migration operation to render.
 * @returns PostgreSQL DDL or raw SQL.
 */
const compilePostgresOperation = (operation: MigrationOperation): string => {
  const quote = quoteIdent
  switch (operation._tag) {
    case "CreateTable": {
      const columns = operation.columns.map((column) => {
        const parts = [
          quote(column.name),
          column.type,
          column.generated ? `generated always as (${column.generated.expression}) stored` : "",
          column.nullable ? "" : "not null",
          column.unique ? "unique" : "",
          column.default ? `default ${defaultSql(column.default)}` : ""
        ]
        return "  " + parts.filter(Boolean).join(" ")
      })
      if (operation.primaryKey.length > 0) {
        columns.push(`  primary key (${operation.primaryKey.map(quote).join(", ")})`)
      }
      for (const constraint of operation.uniqueConstraints ?? []) {
        columns.push(`  ${constraint.name ? `constraint ${quote(constraint.name)} ` : ""}unique (${constraint.columns.map(quote).join(", ")})`)
      }
      for (const check of operation.checks ?? []) {
        columns.push(`  ${check.name ? `constraint ${quote(check.name)} ` : ""}check (${check.expression})`)
      }
      for (const foreignKey of operation.foreignKeys ?? []) {
        columns.push(`  ${foreignKey.name ? `constraint ${quote(foreignKey.name)} ` : ""}foreign key (${foreignKey.columns.map(quote).join(", ")}) references ${quote(foreignKey.references.table)} (${foreignKey.references.columns.map(quote).join(", ")})${foreignKey.onDelete ? ` on delete ${foreignKey.onDelete}` : ""}${foreignKey.onUpdate ? ` on update ${foreignKey.onUpdate}` : ""}`)
      }
      const create = `create table ${quote(operation.table)} (\n${columns.join(",\n")}\n);`
      const indexes = (operation.indexes ?? []).map((index) =>
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
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${column.type}${column.generated ? ` generated always as (${column.generated.expression}) stored` : ""}${column.nullable ? "" : " not null"}${column.unique ? " unique" : ""}${column.default ? ` default ${defaultSql(column.default)}` : ""};`
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
