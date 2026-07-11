/**
 * Column DSL (spec §5).
 *
 * A `Column` is simultaneously:
 *   - a schema descriptor (name, SQL data type, codec, constraints), and
 *   - a query-referenceable expression (`users.id` in `eq(users.id, x)`).
 *
 * The phantom `ColumnConfig` type parameter is what powers compile-time
 * Select/Insert/Update inference (see ./table.ts). It never exists at runtime.
 *
 * @module schema/column
 */
import { Schema } from "effect"
import { internIdentifier } from "../ir/identifiers.js"

/** Logical column data types rendered independently by each dialect. */
export type SqlDataType =
  | "uuid"
  | "text"
  | "varchar"
  | "integer"
  | "bigint"
  | "real"
  | "double precision"
  | "boolean"
  | "timestamptz"
  | "timestamp"
  | "date"
  | "jsonb"
  | "json"

/** How a column's default is produced. */
export type DefaultValue =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "sql"; readonly sql: string }
  | { readonly kind: "random" }
  | { readonly kind: "now" }

/** Referential action applied by a foreign key on delete/update. */
export type ForeignKeyAction = "cascade" | "restrict" | "set null" | "no action"

/**
 * A column-level foreign-key reference (spec §13.2). The target column is a
 * deferred thunk so self-references and forward references between tables resolve
 * lazily (only when the owning table's metadata is read).
 */
export interface ColumnReference {
  /**
   * Deferred referenced column, e.g. `() => posts.id`.
   *
   * @returns The referenced (bound) column.
   */
  readonly column: () => AnyColumn
  readonly onDelete?: ForeignKeyAction
  readonly onUpdate?: ForeignKeyAction
}

/** Runtime column descriptor. Non-generic; carries everything the IR/compiler need. */
export interface ColumnDef {
  readonly name: string
  /** Owning table name; `""` until the column is attached to a table. */
  readonly table: string
  readonly dataType: SqlDataType
  readonly codec: Schema.Schema<any, any>
  readonly notNull: boolean
  readonly hasDefault: boolean
  readonly defaultValue?: DefaultValue
  readonly primaryKey: boolean
  readonly unique: boolean
  readonly generated: boolean
  /** Deferred foreign-key reference declared with `.references()`. */
  readonly references?: ColumnReference
}

/** Phantom, type-level view of a column used for row-shape inference. */
export interface ColumnConfig {
  readonly name: string
  /** Owning table or query alias, attached by `table()`/`alias()` for join typing. */
  readonly table?: string
  /** Decoded, non-null scalar TS type. */
  readonly data: unknown
  readonly notNull: boolean
  readonly hasDefault: boolean
  readonly generated: boolean
}

/** Rebinds a column's phantom configuration to an owning table name. */
export type BoundColumn<T, Name extends string> = T extends Column<infer C>
  ? Column<Omit<C, "table"> & { readonly table: Name }>
  : never

/** Intersect a config with a patch, letting the patch's fields win. */
type Patch<C, P> = Omit<C, keyof P> & P
/** The decoded, non-null scalar type of a config (`unknown` if absent). */
type ConfigData<C> = C extends { readonly data: infer D } ? D : unknown

const PHANTOM: unique symbol = Symbol.for("thor/column-config")

/**
 * Immutable schema column descriptor and query expression.
 *
 * @stable
 * @typeParam C - Phantom configuration used for row-shape inference.
 */
export class Column<C = ColumnConfig> {
  /** Phantom config carrier — never read at runtime. */
  declare readonly [PHANTOM]: C

  /**
   * @param def - Complete runtime column definition.
   */
  constructor(readonly def: ColumnDef) {}

  /**
   * @param patch - Runtime definition fields to replace.
   * @returns A new immutable column.
   */
  private with<P extends Partial<ColumnConfig>>(patch: Partial<ColumnDef>): Column<Patch<C, P>> {
    return new Column<Patch<C, P>>({ ...this.def, ...patch })
  }

  /**
   * @returns A new column marked `NOT NULL`.
   */
  notNull(): Column<Patch<C, { notNull: true }>> {
    return this.with<{ notNull: true }>({ notNull: true })
  }

  /**
   * @returns A new nullable column.
   */
  nullable(): Column<Patch<C, { notNull: false }>> {
    return this.with<{ notNull: false }>({ notNull: false })
  }

  /**
   * @returns A new primary-key column, implicitly marked `NOT NULL`.
   */
  primaryKey(): Column<Patch<C, { notNull: true }>> {
    return this.with<{ notNull: true }>({ primaryKey: true, notNull: true })
  }

  /**
   * @returns A new column with a `UNIQUE` constraint.
   */
  unique(): Column<C> {
    return new Column<C>({ ...this.def, unique: true })
  }

  /**
   * Declares a foreign key from this column to another table's column (spec §13.2).
   * The target is a deferred thunk so self- and forward-references resolve lazily.
   *
   * ```ts
   * authorId: pg.uuid("author_id").notNull().references(() => authors.id, { onDelete: "cascade" })
   * ```
   *
   * @param column - Deferred referenced column, e.g. `() => authors.id`.
   * @param options - Optional `onDelete`/`onUpdate` referential actions.
   * @returns A new column carrying the foreign-key reference.
   */
  references(
    column: () => AnyColumn,
    options: { readonly onDelete?: ForeignKeyAction; readonly onUpdate?: ForeignKeyAction } = {}
  ): Column<C> {
    return new Column<C>({
      ...this.def,
      references: {
        column,
        ...(options.onDelete ? { onDelete: options.onDelete } : {}),
        ...(options.onUpdate ? { onUpdate: options.onUpdate } : {})
      }
    })
  }

  /**
   * Adds a literal default value.
   *
   * @param value - Default matching the decoded column type.
   * @returns A new column whose insert field is optional.
   */
  default(value: ConfigData<C>): Column<Patch<C, { hasDefault: true }>> {
    return this.with<{ hasDefault: true }>({ hasDefault: true, defaultValue: { kind: "value", value } })
  }

  /**
   * Adds a trusted SQL default expression.
   *
   * @param sql - Dialect-compatible SQL expression.
   * @returns A new column whose insert field is optional.
   */
  defaultSql(sql: string): Column<Patch<C, { hasDefault: true }>> {
    return this.with<{ hasDefault: true }>({ hasDefault: true, defaultValue: { kind: "sql", sql } })
  }

  /**
   * @returns A new column using the active dialect's random UUID default.
   */
  defaultRandom(): Column<Patch<C, { hasDefault: true }>> {
    return this.with<{ hasDefault: true }>({ hasDefault: true, defaultValue: { kind: "random" } })
  }

  /**
   * @returns A new column using the active dialect's current-time default.
   */
  defaultNow(): Column<Patch<C, { hasDefault: true }>> {
    return this.with<{ hasDefault: true }>({ hasDefault: true, defaultValue: { kind: "now" } })
  }

  /**
   * Marks the column as generated by the database.
   *
   * @param sql - Trusted generation expression.
   * @returns A new column omitted from insert and update types.
   */
  generatedAlwaysAs(sql: string): Column<Patch<C, { generated: true; hasDefault: true }>> {
    return this.with<{ generated: true; hasDefault: true }>({
      generated: true,
      hasDefault: true,
      defaultValue: { kind: "sql", sql }
    })
  }
}

/** Any column, regardless of config. */
export type AnyColumn = Column<any>

/**
 * The codec used to validate and encode an application value bound to this
 * column. Nullable columns widen the base codec with `Schema.NullOr` so that
 * inline values (and decoded rows) accept `null`, mirroring the selection
 * decode path. Keeping encode and decode nullability in lock-step is what makes
 * inline and named parameter binding consistent (spec §5, P0.2).
 *
 * @param column - Column supplying the codec and nullability.
 * @returns The column's nullability-aware codec.
 */
export const columnParamCodec = (column: AnyColumn): Schema.Schema<any, any> =>
  column.def.notNull ? column.def.codec : Schema.NullOr(column.def.codec)

/**
 * Creates a nullable column with no constraints or default.
 *
 * @typeParam Name - Literal SQL column name.
 * @typeParam Data - Decoded scalar value type.
 * @param name - SQL column name.
 * @param dataType - Logical data type rendered by the active dialect.
 * @param codec - Effect Schema codec used for result decoding.
 * @returns A new base column descriptor.
 */
const makeColumn = <Name extends string, Data>(
  name: Name,
  dataType: SqlDataType,
  codec: Schema.Schema<any, any>
): Column<{ name: Name; data: Data; notNull: false; hasDefault: false; generated: false }> => {
  const identifier = internIdentifier(name) as Name
  return new Column({
    name: identifier,
    table: "",
    dataType,
    codec,
    notNull: false,
    hasDefault: false,
    primaryKey: false,
    unique: false,
    generated: false
  })
}

export { makeColumn }
