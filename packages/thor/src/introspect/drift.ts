/**
 * Drift detection (spec §16.5): diff a live {@link IntrospectedSchema} against the
 * schema-as-code model.
 *
 * Drift is scoped to **structural** differences that compare reliably across the
 * two representations: table presence, column presence, column nullability,
 * primary keys, and foreign keys. Column *type* diffing is deferred — SQLite's
 * type affinity collapses distinct logical types (uuid/text/timestamp all become
 * `TEXT`), so a cross-representation type comparison would produce false drift.
 *
 * @module introspect/drift
 */
import { type AnyTable, tableMeta } from "../schema/table.js"
import type { IntrospectedSchema, IntrospectedTable } from "./schema-ir.js"

/** A single detected difference between the live database and schema-as-code. */
export type DriftChange =
  | { readonly _tag: "MissingTable"; readonly table: string; readonly message: string }
  | { readonly _tag: "ExtraTable"; readonly table: string; readonly message: string }
  | { readonly _tag: "MissingColumn"; readonly table: string; readonly column: string; readonly message: string }
  | { readonly _tag: "ExtraColumn"; readonly table: string; readonly column: string; readonly message: string }
  | {
      readonly _tag: "NullabilityChanged"
      readonly table: string
      readonly column: string
      readonly expectedNullable: boolean
      readonly actualNullable: boolean
      readonly message: string
    }
  | {
      readonly _tag: "PrimaryKeyChanged"
      readonly table: string
      readonly expected: ReadonlyArray<string>
      readonly actual: ReadonlyArray<string>
      readonly message: string
    }
  | { readonly _tag: "MissingForeignKey"; readonly table: string; readonly columns: ReadonlyArray<string>; readonly message: string }
  | { readonly _tag: "ExtraForeignKey"; readonly table: string; readonly columns: ReadonlyArray<string>; readonly message: string }

/** The outcome of a drift check (spec §16.5). */
export interface DriftReport {
  /** Every detected difference; empty when the database matches the schema. */
  readonly changes: ReadonlyArray<DriftChange>
  /** `true` when there is no drift. */
  readonly inSync: boolean
}

/** Options refining a drift check. */
export interface DriftOptions {
  /** Table names to ignore (defaults to the migration journal `_thor_migrations`). */
  readonly ignoreTables?: ReadonlyArray<string>
}

/**
 * @param a - First string array.
 * @param b - Second string array.
 * @returns Whether both arrays are equal element-by-element and in order.
 */
const arraysEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/**
 * A stable, order-insensitive identity for a foreign key.
 *
 * @param columns - Local key columns.
 * @param table - Referenced table.
 * @param refColumns - Referenced columns.
 * @returns A comparable identity string.
 */
const foreignKeyKey = (columns: ReadonlyArray<string>, table: string, refColumns: ReadonlyArray<string>): string =>
  `${[...columns].sort().join(",")}=>${table}(${[...refColumns].sort().join(",")})`

/**
 * Diff one table's columns, primary key, and foreign keys.
 *
 * @param name - Table name.
 * @param expected - Schema-as-code table.
 * @param live - Introspected live table.
 * @param changes - Accumulator to push detected changes onto.
 * @returns Nothing.
 */
const diffTable = (name: string, expected: AnyTable, live: IntrospectedTable, changes: DriftChange[]): void => {
  const meta = tableMeta(expected)
  const expectedColumns = new Map(
    Object.values(meta.columns).map((column) => [column.def.name, { nullable: !column.def.notNull }])
  )
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]))

  for (const [column, spec] of expectedColumns) {
    const liveColumn = liveColumns.get(column)
    if (!liveColumn) {
      changes.push({ _tag: "MissingColumn", table: name, column, message: `column "${name}"."${column}" is missing from the database` })
      continue
    }
    if (spec.nullable !== liveColumn.nullable) {
      changes.push({
        _tag: "NullabilityChanged",
        table: name,
        column,
        expectedNullable: spec.nullable,
        actualNullable: liveColumn.nullable,
        message: `column "${name}"."${column}" is ${liveColumn.nullable ? "nullable" : "not null"} in the database but ${spec.nullable ? "nullable" : "not null"} in the schema`
      })
    }
  }
  for (const column of liveColumns.keys()) {
    if (!expectedColumns.has(column)) {
      changes.push({ _tag: "ExtraColumn", table: name, column, message: `column "${name}"."${column}" exists in the database but not in the schema` })
    }
  }

  if (!arraysEqual(meta.primaryKey, live.primaryKey)) {
    changes.push({
      _tag: "PrimaryKeyChanged",
      table: name,
      expected: meta.primaryKey,
      actual: live.primaryKey,
      message: `primary key of "${name}" is [${live.primaryKey.join(", ")}] in the database but [${meta.primaryKey.join(", ")}] in the schema`
    })
  }

  const expectedForeignKeys = new Map(
    meta.foreignKeys.map((fk) => [foreignKeyKey(fk.columns, fk.references.table, fk.references.columns), fk])
  )
  const liveForeignKeys = new Map(
    live.foreignKeys.map((fk) => [foreignKeyKey(fk.columns, fk.references.table, fk.references.columns), fk])
  )
  for (const [key, fk] of expectedForeignKeys) {
    if (!liveForeignKeys.has(key)) {
      changes.push({ _tag: "MissingForeignKey", table: name, columns: fk.columns, message: `foreign key on "${name}" (${fk.columns.join(", ")}) is missing from the database` })
    }
  }
  for (const [key, fk] of liveForeignKeys) {
    if (!expectedForeignKeys.has(key)) {
      changes.push({ _tag: "ExtraForeignKey", table: name, columns: fk.columns, message: `foreign key on "${name}" (${fk.columns.join(", ")}) exists in the database but not in the schema` })
    }
  }
}

/**
 * Diff the live database shape against the schema-as-code model (spec §16.5).
 *
 * @param expected - Schema-as-code tables.
 * @param live - Introspected live schema.
 * @param options - Drift options (e.g. ignored tables).
 * @returns A drift report; `inSync` is `true` when there are no changes.
 */
export const detectDrift = (
  expected: ReadonlyArray<AnyTable>,
  live: IntrospectedSchema,
  options: DriftOptions = {}
): DriftReport => {
  const ignore = new Set(options.ignoreTables ?? ["_thor_migrations"])
  const changes: DriftChange[] = []
  const liveByName = new Map(live.tables.map((table) => [table.name, table]))
  const expectedByName = new Map(expected.map((table) => [tableMeta(table).name, table]))

  for (const [name, table] of expectedByName) {
    const liveTable = liveByName.get(name)
    if (!liveTable) {
      changes.push({ _tag: "MissingTable", table: name, message: `table "${name}" is missing from the database` })
      continue
    }
    diffTable(name, table, liveTable, changes)
  }

  for (const liveTable of live.tables) {
    if (ignore.has(liveTable.name)) continue
    if (!expectedByName.has(liveTable.name)) {
      changes.push({ _tag: "ExtraTable", table: liveTable.name, message: `table "${liveTable.name}" exists in the database but not in the schema` })
    }
  }

  return { changes, inSync: changes.length === 0 }
}
