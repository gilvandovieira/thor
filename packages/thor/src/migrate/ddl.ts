/**
 * DDL compilation and schema diffing (spec §13.5–13.6). Kept separate from the
 * package barrel so the live migrator can import it without an import cycle.
 *
 * @module migrate/ddl
 */
import type { AnyColumn } from "../schema/column.js"
import { type AnyTable, tableMeta } from "../schema/table.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"
import type {
  ColumnDefault,
  ColumnSpec,
  CreateTableOp,
  DefaultLiteral,
  MigrationOperation,
  MigrationPlan
} from "./migration-ir.js"

/**
 * Converts runtime column-default metadata to dialect-neutral SQL.
 *
 * @param column - Column whose default should be rendered.
 * @returns Default SQL, or `undefined` when the column has no default.
 */
const renderDefault = (column: AnyColumn): ColumnDefault | undefined => {
  const d = column.def.defaultValue
  if (!d) return undefined
  switch (d.kind) {
    case "now":
      return { kind: "now" }
    case "random":
      return { kind: "random" }
    case "sql":
      return column.def.generated ? undefined : { kind: "sql", sql: d.sql }
    case "value":
      if (
        d.value !== null &&
        typeof d.value !== "string" &&
        typeof d.value !== "number" &&
        typeof d.value !== "bigint" &&
        typeof d.value !== "boolean" &&
        !(d.value instanceof Date)
      ) {
        throw new TypeError(`Column "${column.def.table}.${column.def.name}" has a non-round-trippable default value`)
      }
      return { kind: "value", value: d.value as DefaultLiteral }
  }
}

/**
 * @param column - Runtime schema column.
 * @returns Dialect-neutral migration column specification.
 */
export const columnSpecOf = (column: AnyColumn): ColumnSpec => {
  const base: ColumnSpec = {
    name: column.def.name,
    type: column.def.dataType,
    nullable: !column.def.notNull,
    ...(column.def.unique ? { unique: true } : {}),
    ...(column.def.generated && column.def.defaultValue?.kind === "sql"
      ? { generated: { expression: column.def.defaultValue.sql, stored: true } }
      : {})
  }
  const dflt = renderDefault(column)
  return dflt === undefined ? base : { ...base, default: dflt }
}

/**
 * @param table - Runtime schema table.
 * @returns Reversible `CreateTable` migration operation.
 */
export const tableToCreateOp = (table: AnyTable): CreateTableOp => {
  const meta = tableMeta(table)
  return {
    _tag: "CreateTable",
    table: meta.name,
    columns: Object.values(meta.columns).map(columnSpecOf),
    primaryKey: meta.primaryKey,
    uniqueConstraints: meta.uniqueConstraints.map((constraint) => ({ ...constraint })),
    checks: meta.checks.map((check) => ({ ...check, expression: check.expression.sql })),
    foreignKeys: meta.foreignKeys.map((foreignKey) => ({ ...foreignKey, references: { ...foreignKey.references } })),
    indexes: meta.indexes.map((index) => ({ ...index })),
    destructive: false,
    reversible: true,
    capabilities: []
  }
}

/**
 * Diff the current schema against a previous snapshot (spec §13.5). v0 supports
 * the create-only path: tables absent from `previous` become `CreateTable` ops.
 * (Column-level diff / rename detection is Milestone 8+.)
 *
 * @param current - Current application schema tables.
 * @param previous - Table names present in the prior snapshot.
 * @returns Create operations for tables absent from the snapshot.
 */
export const diffSchema = (
  current: ReadonlyArray<AnyTable>,
  previous: ReadonlyArray<string> = []
): ReadonlyArray<MigrationOperation> => {
  const known = new Set(previous)
  return current.filter((t) => !known.has(tableMeta(t).name)).map(tableToCreateOp)
}

/**
 * @param op - Migration operation to compile.
 * @param dialect - Target backend dialect; defaults to PostgreSQL.
 * @returns Executable dialect-specific SQL.
 */
export const compileOperation = (op: MigrationOperation, dialect: Dialect = PostgresDialect): string =>
  dialect.migrations.compileOperation(op)

/**
 * @param plan - Ordered migration plan.
 * @param dialect - Target backend dialect; defaults to PostgreSQL.
 * @returns DDL statements joined by blank lines in operation order.
 */
export const compilePlan = (plan: MigrationPlan, dialect: Dialect = PostgresDialect): string =>
  plan.operations.map((op) => compileOperation(op, dialect)).join("\n\n")
