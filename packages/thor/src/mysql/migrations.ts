/**
 * MySQL DDL compiler and migrator lifecycle SQL.
 *
 * @module mysql/migrations
 */
import type { MigrationDialect } from "../dialect.js"
import {
  type ColumnDefault,
  type ColumnSpec,
  type DefaultLiteral,
  type MigrationOperation,
  unsafeSyntax
} from "../migrate/migration-ir.js"

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
const literal = (value: DefaultLiteral): string => {
  if (value === null) return "null"
  // MySQL treats backslash as an escape character inside string literals by
  // default, so `\'` would close the literal early; escape both. (Servers
  // running NO_BACKSLASH_ESCAPES read doubled backslashes literally — DDL
  // defaults containing backslashes are not portable to that mode.)
  if (value instanceof Date) return `'${value.toISOString().replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite DDL default")
  return String(value)
}

/** @param value - Dialect-neutral default. @returns MySQL default SQL. */
const mysqlDefault = (value: ColumnDefault): string => {
  switch (value.kind) {
    case "value":
      return literal(value.value)
    case "sql":
      return value.sql
    case "now":
      return "CURRENT_TIMESTAMP(3)"
    case "random":
      return "(uuid())"
  }
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
          column.generated
            ? `generated always as (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}`
            : "",
          column.nullable ? "" : "not null",
          column.unique ? "unique" : "",
          column.default ? `default ${mysqlDefault(column.default)}` : ""
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
      for (const index of operation.indexes ?? []) {
        columns.push(
          `  ${index.unique ? "unique " : ""}index ${quote(index.name)} (${index.columns.map(quote).join(", ")})`
        )
      }
      return `create table ${quote(operation.table)} (\n${columns.join(",\n")}\n);`
    }
    case "DropTable":
      return `drop table ${quote(operation.table)};`
    case "RenameTable":
      return `rename table ${quote(operation.from)} to ${quote(operation.to)};`
    case "AddColumn": {
      const column = operation.column
      return `alter table ${quote(operation.table)} add column ${quote(column.name)} ${mysqlType(column.type)}${column.generated ? ` generated always as (${column.generated.expression}) ${column.generated.stored ? "stored" : "virtual"}` : ""}${column.nullable ? "" : " not null"}${column.unique ? " unique" : ""}${column.default ? ` default ${mysqlDefault(column.default)}` : ""};`
    }
    case "DropColumn":
      return `alter table ${quote(operation.table)} drop column ${quote(operation.column)};`
    case "RenameColumn":
      return `alter table ${quote(operation.table)} rename column ${quote(operation.from)} to ${quote(operation.to)};`
    case "AlterColumnType":
    case "SetNotNull":
    case "DropNotNull":
      return unsupportedAlter(operation)
    case "CreateRoutine": {
      // MySQL has no CREATE OR REPLACE for routines and no LANGUAGE/`$$` — the
      // trusted body carries characteristics + BEGIN/END. Live execution needs a
      // DELIMITER-aware driver for multi-statement bodies.
      const args = operation.args
        .map((arg) => `${arg.name ? `${quote(arg.name)} ` : ""}${unsafeSyntax(arg.type, "argument type")}`)
        .join(", ")
      const returns =
        operation.routine === "function" && operation.returns
          ? ` returns ${unsafeSyntax(operation.returns, "return type")}`
          : ""
      return `create ${operation.routine} ${quote(operation.name)}(${args})${returns} ${unsafeSyntax(operation.body, "body")}`
    }
    case "DropRoutine":
      // MySQL DROP FUNCTION/PROCEDURE takes no argument list.
      return `drop ${operation.routine} ${operation.ifExists ? "if exists " : ""}${quote(operation.name)};`
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
    -- Holds versioned digests such as sha256:v1:<64 hex> (74 chars) and legacy
    -- 8-char FNV-1a hashes; 255 leaves room for future algorithms.
    checksum varchar(255) not null,
    applied_at datetime(3) not null,
    execution_time_ms int not null
  );`,
  /**
   * Journals created before the sha256 checksum format used `varchar(64)`,
   * which cannot hold the 74-character `sha256:v1:<digest>` value: on strict
   * MySQL the journal insert would fail *after* the non-transactional DDL ran,
   * leaving a half-applied migration. Widen in place (an in-place metadata
   * change; history rows are untouched).
   *
   * @param table - Journal table name.
   * @returns Probe/decision/upgrade for the checksum column width.
   */
  upgradeJournal: (table) => ({
    probe: {
      sql: "select character_maximum_length as len from information_schema.columns where table_schema = database() and table_name = ? and column_name = 'checksum'",
      params: [table]
    },
    needsUpgrade: (rows) => rows.length > 0 && Number(rows[0]?.len) < 255,
    upgrade: `alter table ${quoteIdent(table)} modify checksum varchar(255) not null;`
  }),
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
  releaseLock: (key) => ({
    sql: "select release_lock(?) as released",
    params: [lockName(key)],
    resultCheck: (rows) => Number(rows[0]?.released) === 1,
    failureMessage: "MySQL migration named lock was lost before release"
  }),
  transactionalDdl: false,
  beginTransaction: "start transaction",
  commitTransaction: "commit",
  rollbackTransaction: "rollback",
  listTables:
    "select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE'"
}
