/**
 * Table DSL and schema-derived row types (spec §5.1).
 *
 * `pg.table(name, cols)` returns an object whose own enumerable keys are the
 * columns (so `users.id` works as an expression) plus a non-enumerable metadata
 * symbol. `Select`/`Insert`/`Update` derive the three row shapes from the
 * columns' phantom configs.
 *
 * @module schema/table
 */
import type { AnyColumn, BoundColumn, Column } from "./column.js"
import { internIdentifier } from "../ir/identifiers.js"
import type { UnsafeSqlNode } from "../ir/query-ir.js"
import { isUnsafeSqlNode } from "../ir/unsafe-sql.js"
import { authenticitySet } from "../ir/authenticity.js"
import { sourceIdentity } from "../ir/source-identity.js"

/** Non-enumerable key carrying a table's runtime metadata. */
export const TableMeta: unique symbol = Symbol.for("thor/table-meta")
const tables = authenticitySet("table")

/** Runtime description of a table index. */
export interface TableIndex {
  readonly name: string
  readonly columns: ReadonlyArray<string>
  readonly unique: boolean
}

/** Table-level unique constraint. */
export interface TableUniqueConstraint {
  readonly name?: string
  readonly columns: ReadonlyArray<string>
}

/** Table-level trusted check expression. */
export interface TableCheckConstraint {
  readonly name?: string
  readonly expression: UnsafeSqlNode
}

/** Table-level foreign key metadata. */
export interface TableForeignKey {
  readonly name?: string
  readonly columns: ReadonlyArray<string>
  readonly references: { readonly table: string; readonly columns: ReadonlyArray<string> }
  readonly onDelete?: "cascade" | "restrict" | "set null" | "no action"
  readonly onUpdate?: "cascade" | "restrict" | "set null" | "no action"
}

/** Optional lossless DDL metadata accepted by `table()`. Column names are application keys. */
export interface TableOptions<Cols extends Columns> {
  readonly indexes?: ReadonlyArray<{
    readonly name: string
    readonly columns: ReadonlyArray<Extract<keyof Cols, string>>
    readonly unique?: boolean
  }>
  readonly uniqueConstraints?: ReadonlyArray<{
    readonly name?: string
    readonly columns: ReadonlyArray<Extract<keyof Cols, string>>
  }>
  readonly checks?: ReadonlyArray<TableCheckConstraint>
  readonly foreignKeys?: ReadonlyArray<{
    readonly name?: string
    readonly columns: ReadonlyArray<Extract<keyof Cols, string>>
    readonly references: TableForeignKey["references"]
    readonly onDelete?: TableForeignKey["onDelete"]
    readonly onUpdate?: TableForeignKey["onUpdate"]
  }>
}

/** Runtime metadata stored on every table through `TableMeta`. */
export interface TableMetadata {
  readonly name: string
  /** Visible SQL alias used by query scope and column references. */
  readonly alias?: string
  readonly sourceId: object
  readonly columns: Readonly<Record<string, AnyColumn>>
  readonly primaryKey: ReadonlyArray<string>
  readonly indexes: ReadonlyArray<TableIndex>
  readonly uniqueConstraints: ReadonlyArray<TableUniqueConstraint>
  readonly checks: ReadonlyArray<TableCheckConstraint>
  readonly foreignKeys: ReadonlyArray<TableForeignKey>
}

/** The columns record for a table. */
export type Columns = Record<string, AnyColumn>

/**
 * A table is its columns plus hidden metadata. The metadata is written inline
 * (not `TableMetadata & ...`) so `columns` stays exactly `Cols` — intersecting
 * with the broad `Record<string, AnyColumn>` would inject an index signature and
 * poison the derived row types.
 *
 * @typeParam Name - Literal SQL table name.
 * @typeParam Cols - Named column record exposed on the table value.
 */
export type Table<Name extends string, Cols extends Columns> = Cols & {
  readonly [TableMeta]: {
    readonly name: Name
    readonly alias?: string
    readonly sourceId: object
    readonly columns: Cols
    readonly primaryKey: ReadonlyArray<string>
    readonly indexes: ReadonlyArray<TableIndex>
    readonly uniqueConstraints: ReadonlyArray<TableUniqueConstraint>
    readonly checks: ReadonlyArray<TableCheckConstraint>
    readonly foreignKeys: ReadonlyArray<TableForeignKey>
  }
}

/** Any table. */
export type AnyTable = Table<string, Columns>

type BoundColumns<Name extends string, Cols extends Columns> = {
  readonly [K in keyof Cols]: BoundColumn<Cols[K], Name>
}

// --- type-level column projections ------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type ConfigOf<T> = T extends Column<infer C> ? C : never
type IsTrue<T> = [T] extends [true] ? true : false
type NotNull<T> = IsTrue<ConfigOf<T> extends { readonly notNull: infer N } ? N : false>
type HasDefault<T> = IsTrue<ConfigOf<T> extends { readonly hasDefault: infer H } ? H : false>
type Generated<T> = IsTrue<ConfigOf<T> extends { readonly generated: infer G } ? G : false>
type DataOf<T> = ConfigOf<T> extends { readonly data: infer D } ? D : unknown

/** The decoded value of a column as it appears in a selected row. */
type ColSelect<T> = NotNull<T> extends true ? DataOf<T> : DataOf<T> | null

type ColsOf<T> = T extends { readonly [TableMeta]: { readonly columns: infer C } } ? C : never

// --- Select -----------------------------------------------------------------

/**
 * The row shape returned when selecting every column of a table.
 *
 * @stable
 */
export type Select<T extends AnyTable> = Simplify<{
  readonly [K in keyof ColsOf<T>]: ColSelect<ColsOf<T>[K]>
}>

// --- Insert -----------------------------------------------------------------
// Generated columns are omitted. Columns with a default or that are nullable
// are optional; not-null columns without a default are required.

type InsertRequiredKeys<Cols> = {
  [K in keyof Cols]: Generated<Cols[K]> extends true
    ? never
    : HasDefault<Cols[K]> extends true
      ? never
      : NotNull<Cols[K]> extends true
        ? K
        : never
}[keyof Cols]

type InsertOptionalKeys<Cols> = {
  [K in keyof Cols]: Generated<Cols[K]> extends true
    ? never
    : HasDefault<Cols[K]> extends true
      ? K
      : NotNull<Cols[K]> extends true
        ? never
        : K
}[keyof Cols]

/** The accepted input shape for inserting a row. */
export type Insert<T extends AnyTable> = Simplify<
  { [K in InsertRequiredKeys<ColsOf<T>>]: ColSelect<ColsOf<T>[K]> } & {
    [K in InsertOptionalKeys<ColsOf<T>>]?: ColSelect<ColsOf<T>[K]>
  }
>

// --- Update -----------------------------------------------------------------

type UpdatableKeys<Cols> = {
  [K in keyof Cols]: Generated<Cols[K]> extends true ? never : K
}[keyof Cols]

/** The accepted input shape for updating a row (all non-generated columns optional). */
export type Update<T extends AnyTable> = Simplify<{
  [K in UpdatableKeys<ColsOf<T>>]?: ColSelect<ColsOf<T>[K]>
}>

// --- construction -----------------------------------------------------------

/**
 * Build a table from a name and columns. Each column is re-homed onto this
 * table (its `def.table` is set) and primary-key columns are collected.
 *
 * @typeParam Name - Literal SQL table name.
 * @typeParam Cols - Named column record.
 * @stable
 * @param name - SQL table name.
 * @param columns - Column definitions keyed by application property name.
 * @param options - Optional indexes and table-level constraints.
 * @returns A table whose properties are bound column references.
 */
export const defineTable = <Name extends string, Cols extends Columns>(
  name: Name,
  columns: Cols,
  options: TableOptions<Cols> = {}
): Table<Name, BoundColumns<Name, Cols>> => {
  const tableName = internIdentifier(name) as Name
  const sourceId = sourceIdentity()
  const boundColumns: Record<string, AnyColumn> = {}
  const primaryKey: string[] = []

  for (const [key, column] of Object.entries(columns)) {
    const bound = new (column.constructor as typeof Column)({
      ...column.def,
      name: internIdentifier(column.def.name),
      table: tableName,
      sourceId
    })
    boundColumns[key] = bound
    if (column.def.primaryKey) primaryKey.push(column.def.name)
  }

  const tableForeignKeys: ReadonlyArray<TableForeignKey> = (options.foreignKeys ?? []).map((foreignKey) => ({
    ...(foreignKey.name ? { name: internIdentifier(foreignKey.name) } : {}),
    columns: foreignKey.columns.map((key) => columns[key]!.def.name),
    references: foreignKey.references,
    ...(foreignKey.onDelete ? { onDelete: foreignKey.onDelete } : {}),
    ...(foreignKey.onUpdate ? { onUpdate: foreignKey.onUpdate } : {})
  }))

  // Column-level `.references()` thunks resolve lazily (memoized) so self- and
  // forward-references between tables are valid regardless of definition order.
  let resolvedForeignKeys: ReadonlyArray<TableForeignKey> | undefined
  const collectForeignKeys = (): ReadonlyArray<TableForeignKey> => {
    if (resolvedForeignKeys) return resolvedForeignKeys
    const columnForeignKeys: TableForeignKey[] = []
    for (const [key, column] of Object.entries(columns)) {
      const reference = column.def.references
      if (!reference) continue
      const target = reference.column()
      columnForeignKeys.push({
        columns: [columns[key]!.def.name],
        references: { table: target.def.table, columns: [target.def.name] },
        ...(reference.onDelete ? { onDelete: reference.onDelete } : {}),
        ...(reference.onUpdate ? { onUpdate: reference.onUpdate } : {})
      })
    }
    resolvedForeignKeys = [...tableForeignKeys, ...columnForeignKeys]
    return resolvedForeignKeys
  }

  const meta: TableMetadata = {
    name: tableName,
    sourceId,
    columns: boundColumns,
    primaryKey,
    indexes: (options.indexes ?? []).map((index) => ({
      name: internIdentifier(index.name),
      columns: index.columns.map((key) => columns[key]!.def.name),
      unique: index.unique ?? false
    })),
    uniqueConstraints: (options.uniqueConstraints ?? []).map((constraint) => ({
      ...(constraint.name ? { name: internIdentifier(constraint.name) } : {}),
      columns: constraint.columns.map((key) => columns[key]!.def.name)
    })),
    checks: (options.checks ?? []).map((check) => {
      if (!isUnsafeSqlNode(check.expression)) throw new TypeError("Table check expressions require unsafeSql(...)")
      return {
        ...(check.name ? { name: internIdentifier(check.name) } : {}),
        expression: check.expression
      }
    }),
    get foreignKeys() {
      return collectForeignKeys()
    }
  }

  const table = { ...boundColumns } as Record<PropertyKey, unknown>
  Object.defineProperty(table, TableMeta, { value: meta, enumerable: false })
  tables.add(table)
  return table as Table<Name, BoundColumns<Name, Cols>>
}

/**
 * @param table - Thor table value.
 * @returns Hidden runtime table metadata.
 */
export const tableMeta = (table: AnyTable): TableMetadata => {
  if (!tables.has(table)) throw new TypeError("Expected a Thor table from a compatible package protocol")
  return table[TableMeta]
}

/**
 * Creates an immutable table reference with a query-local SQL alias.
 *
 * @typeParam T - Source table type.
 * @param table - Table to alias.
 * @param name - Alias visible to column references and scope guards.
 * @returns A table-shaped reference retaining the source column types.
 */
export const alias = <T extends AnyTable, const Name extends string>(table: T, name: Name): T => {
  const source = tableMeta(table)
  const aliasName = internIdentifier(name)
  const sourceId = sourceIdentity()
  const columns: Record<string, AnyColumn> = {}
  for (const [key, column] of Object.entries(source.columns)) {
    columns[key] = new (column.constructor as typeof Column)({
      ...column.def,
      table: aliasName,
      sourceId
    })
  }
  const meta: TableMetadata = {
    name: source.name,
    alias: aliasName,
    sourceId,
    columns,
    primaryKey: source.primaryKey,
    indexes: source.indexes,
    uniqueConstraints: source.uniqueConstraints,
    checks: source.checks,
    foreignKeys: source.foreignKeys
  }
  const value = { ...columns } as Record<PropertyKey, unknown>
  Object.defineProperty(value, TableMeta, { value: meta, enumerable: false })
  tables.add(value)
  return value as T
}

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a Thor table.

 */
export const isTable = (value: unknown): value is AnyTable =>
  typeof value === "object" && value !== null && tables.has(value)
