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
import type { AnyColumn, Column } from "./column.js"
import { internIdentifier } from "../ir/identifiers.js"

/** Non-enumerable key carrying a table's runtime metadata. */
export const TableMeta: unique symbol = Symbol.for("thor/table-meta")

/** Runtime description of a table index. */
export interface TableIndex {
  readonly name: string
  readonly columns: ReadonlyArray<string>
  readonly unique: boolean
}

/** Runtime metadata stored on every table through `TableMeta`. */
export interface TableMetadata {
  readonly name: string
  readonly columns: Readonly<Record<string, AnyColumn>>
  readonly primaryKey: ReadonlyArray<string>
  readonly indexes: ReadonlyArray<TableIndex>
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
    readonly columns: Cols
    readonly primaryKey: ReadonlyArray<string>
    readonly indexes: ReadonlyArray<TableIndex>
  }
}

/** Any table. */
export type AnyTable = Table<string, Columns>

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

/** The row shape returned when selecting every column of a table. */
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
 * @param name - SQL table name.
 * @param columns - Column definitions keyed by application property name.
 * @returns A table whose properties are bound column references.
 */
export const defineTable = <Name extends string, Cols extends Columns>(
  name: Name,
  columns: Cols
): Table<Name, Cols> => {
  const tableName = internIdentifier(name) as Name
  const boundColumns: Record<string, AnyColumn> = {}
  const primaryKey: string[] = []

  for (const [key, column] of Object.entries(columns)) {
    const bound = new (column.constructor as typeof Column)({
      ...column.def,
      name: internIdentifier(column.def.name),
      table: tableName
    })
    boundColumns[key] = bound
    if (column.def.primaryKey) primaryKey.push(column.def.name)
  }

  const meta: TableMetadata = {
    name: tableName,
    columns: boundColumns,
    primaryKey,
    indexes: []
  }

  const table = { ...boundColumns } as Record<PropertyKey, unknown>
  Object.defineProperty(table, TableMeta, { value: meta, enumerable: false })
  return table as Table<Name, Cols>
}

/**
 * @param table - Thor table value.
 * @returns Hidden runtime table metadata.
 */
export const tableMeta = (table: AnyTable): TableMetadata => table[TableMeta]

/**
 * @param value - Unknown runtime value.
 * @returns Whether `value` is a Thor table.

 */
export const isTable = (value: unknown): value is AnyTable =>
  typeof value === "object" && value !== null && TableMeta in value
