/**
 * Introspected Schema IR (spec §16.4).
 *
 * A dialect-neutral description of a **live** database's shape, produced by the
 * {@link Introspector}. It is deliberately close to — but distinct from — the
 * schema-as-code metadata: introspection reports the database's own type text and
 * default expressions verbatim, so drift detection (P2) can compare the live
 * shape against the expected schema.
 *
 * v1 P1/P3 covers tables, columns, primary keys, and foreign keys. Indexes,
 * views, enums, routines, and extensions are tracked as follow-up work.
 *
 * @module introspect/schema-ir
 */
import type { Effect } from "effect"
import type { ConstraintError, DriverError } from "../errors/index.js"
import type { RawRow } from "../execution/driver.js"

/** A column as reported by the live database. */
export interface IntrospectedColumn {
  /** Column name. */
  readonly name: string
  /** Raw dialect type text (e.g. `character varying`, `integer`, `TEXT`). */
  readonly type: string
  /** Whether the column accepts `NULL`. */
  readonly nullable: boolean
  /** Raw default expression, or `null` when the column has no default. */
  readonly default: string | null
}

/** A secondary index as reported by the live database (primary key excluded). */
export interface IntrospectedIndex {
  /** Index name. */
  readonly name: string
  /** Indexed columns, in index order. */
  readonly columns: ReadonlyArray<string>
  /** Whether the index enforces uniqueness. */
  readonly unique: boolean
}

/** A foreign key as reported by the live database. */
export interface IntrospectedForeignKey {
  /** Local columns, in key order. */
  readonly columns: ReadonlyArray<string>
  /** Referenced table and its columns, in key order. */
  readonly references: { readonly table: string; readonly columns: ReadonlyArray<string> }
  /** Referential action on delete, when reported. */
  readonly onDelete?: string
  /** Referential action on update, when reported. */
  readonly onUpdate?: string
}

/** A table as reported by the live database. */
export interface IntrospectedTable {
  /** Table name. */
  readonly name: string
  /** Columns in ordinal order. */
  readonly columns: ReadonlyArray<IntrospectedColumn>
  /** Primary-key columns in key order (empty when none). */
  readonly primaryKey: ReadonlyArray<string>
  /** Foreign keys declared on the table. */
  readonly foreignKeys: ReadonlyArray<IntrospectedForeignKey>
  /** Secondary indexes (excludes the primary-key and constraint-backed indexes). */
  readonly indexes: ReadonlyArray<IntrospectedIndex>
}

/** The live database shape (spec §16.4). */
export interface IntrospectedSchema {
  /** Base tables in name order. */
  readonly tables: ReadonlyArray<IntrospectedTable>
}

/** Runs an introspection query and yields raw rows. */
export type IntrospectionQuery = (
  sql: string
) => Effect.Effect<ReadonlyArray<RawRow>, DriverError | ConstraintError>

/**
 * Per-dialect introspection strategy (spec §16.4). Each dialect owns the SQL it
 * issues (`information_schema`, `pragma`, `SHOW`) and how it parses the result
 * into the dialect-neutral {@link IntrospectedSchema}.
 */
export interface DialectIntrospection {
  /** Dialect identifier this strategy serves. */
  readonly dialect: string
  /**
   * Read the live database's shape.
   *
   * @param query - Runner that executes a read-only SQL statement.
   * @returns The introspected schema.
   */
  readonly currentSchema: (query: IntrospectionQuery) => Effect.Effect<IntrospectedSchema, DriverError | ConstraintError>
}
