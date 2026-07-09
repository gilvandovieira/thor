/**
 * MySQL DDL compiler and migrator lifecycle SQL.
 *
 * @module mysql/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import type { ColumnSpec, MigrationOperation } from "../migrate/migration-ir.js"

/**
 * @param name - Identifier to escape.
 * @returns Backtick-quoted MySQL identifier.
 */
const quoteIdent = (name: string): string => `\`${name.replace(/`/g, "``")}\``

/**
 * @param type - Logical column type.
 * @returns MySQL storage type.
 */
const mysqlType = (type: ColumnSpec["type"]): string => {
  switch (type) {
    case "uuid":
      return "char(36)"
    case "text":
      return "text"
    case "varchar":
      return "varchar(255)"
    case "integer":
      return "int"
    case "bigint":
      return "bigint"
    case "real":
      return "float"
    case "double precision":
      return "double"
    case "boolean":
      return "boolean"
    case "timestamptz":
    case "timestamp":
      return "datetime(3)"
    case "date":
      return "date"
    case "jsonb":
    case "json":
      return "json"
  }
}

/**
 * @param value - Logical default SQL.
 * @returns MySQL-compatible default expression.
 */
const mysqlDefault = (value: string): string => {
  if (value === "now()") return "CURRENT_TIMESTAMP(3)"
  if (value === "gen_random_uuid()") return "(uuid())"
  return value
}

/**
 * @param operation - Unsupported alteration.
 * @returns Never; this function always throws.
 *
 * @throws {Error} Always, with remediation context.
 */
const unsupportedAlter = (operation: MigrationOperation): never => {
  throw new Error(`MySQL migration operation "${operation._tag}" requires the complete column definition`)
}

/**
 * @param operation - Migration operation to render.
 * @returns MySQL DDL or raw SQL.
 * @throws {Error} When an alteration lacks the complete column definition MySQL requires.
 */
export const compileMySQLOperation = (operation: MigrationOperation): string => {
  const quote = quoteIdent
  switch (operation._tag) {
    case "CreateTable": {
      const columns = operation.columns.map((column) => {
        const parts = [
          quote(column.name),
          mysqlType(column.type),
          column.nullable ? "" : "not null",
          column.default ? `default ${mysqlDefault(column.default)}` : ""
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
      return `rename table ${quote(operation.from)} to ${quote(operation.to)};`
    case "AddColumn": {
      const column = operation.column
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${mysqlType(column.type)}${column.nullable ? "" : " not null"}${column.default ? ` default ${mysqlDefault(column.default)}` : ""};`
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

/**
 * @param key - Numeric migrator lock key.
 * @returns MySQL named-lock identifier.
 */
const lockName = (key: number): string => `thor:${key}`

/** MySQL journal, named-lock, transaction, introspection, and DDL strategy. */
export const MySQLMigrations: MigrationDialect = {
  compileOperation: compileMySQLOperation,
  /**
   * @param table - Journal table name.
   * @returns Journal creation DDL.
   */
  ensureJournal: (table) => `create table if not exists ${quoteIdent(table)} (
    id varchar(255) primary key,
    name varchar(255) not null,
    checksum varchar(64) not null,
    applied_at datetime(3) not null,
    execution_time_ms int not null
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
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Named-lock acquisition statement and result check.
   */
  acquireLock: (key) => ({
    sql: "select get_lock(?, 30) as acquired",
    params: [lockName(key)],
    resultCheck: (rows) => Number(rows[0]?.acquired) === 1,
    failureMessage: "Timed out acquiring the MySQL migration lock"
  }),
  /**
   * @param key - Stable numeric migration-lock key.
   * @returns Named-lock release statement.
   */
  releaseLock: (key) => ({ sql: "select release_lock(?)", params: [lockName(key)] }),
  transactionalDdl: false,
  beginTransaction: "start transaction",
  commitTransaction: "commit",
  rollbackTransaction: "rollback",
  listTables:
    "select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE'"
}
