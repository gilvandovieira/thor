/**
 * Migration IR (spec §13.6). Manual and generated migrations both reduce to
 * this shared operation model before guards/execution (invariant §18.4).
 *
 * @module migrate/migration-ir
 */
import type { SqlDataType } from "../schema/column.js"

/** Typed literal accepted as a generated DDL default. */
export type DefaultLiteral = string | number | bigint | boolean | null | Date

/** Defaults retain intent until the active dialect renders them. */
export type ColumnDefault =
  | { readonly kind: "value"; readonly value: DefaultLiteral }
  | { readonly kind: "sql"; readonly sql: string }
  | { readonly kind: "now" }
  | { readonly kind: "random" }

/** Generated-column expression, distinct from a default. */
export interface GeneratedColumnSpec {
  readonly expression: string
  readonly stored: boolean
}

/** Dialect-neutral column description used by migration operations. */
export interface ColumnSpec {
  readonly name: string
  readonly type: SqlDataType
  readonly nullable: boolean
  readonly default?: ColumnDefault
  readonly unique?: boolean
  readonly generated?: GeneratedColumnSpec
}

/** Table-level unique constraint. */
export interface UniqueConstraintSpec {
  readonly name?: string
  readonly columns: ReadonlyArray<string>
}

/** Table-level check constraint with explicitly trusted SQL. */
export interface CheckConstraintSpec {
  readonly name?: string
  readonly expression: string
}

/** Table-level foreign-key constraint. */
export interface ForeignKeySpec {
  readonly name?: string
  readonly columns: ReadonlyArray<string>
  readonly references: { readonly table: string; readonly columns: ReadonlyArray<string> }
  readonly onDelete?: "cascade" | "restrict" | "set null" | "no action"
  readonly onUpdate?: "cascade" | "restrict" | "set null" | "no action"
}

/** Index emitted after its owning table. */
export interface IndexSpec {
  readonly name: string
  readonly columns: ReadonlyArray<string>
  readonly unique: boolean
}

interface OpBase {
  readonly destructive: boolean
  readonly reversible: boolean
  readonly capabilities: ReadonlyArray<string>
}

/** Creates a table with columns and an optional composite primary key. */
export interface CreateTableOp extends OpBase {
  readonly _tag: "CreateTable"
  readonly table: string
  readonly columns: ReadonlyArray<ColumnSpec>
  readonly primaryKey: ReadonlyArray<string>
  readonly uniqueConstraints?: ReadonlyArray<UniqueConstraintSpec>
  readonly checks?: ReadonlyArray<CheckConstraintSpec>
  readonly foreignKeys?: ReadonlyArray<ForeignKeySpec>
  readonly indexes?: ReadonlyArray<IndexSpec>
}
/** Drops a table and all data it contains. */
export interface DropTableOp extends OpBase {
  readonly _tag: "DropTable"
  readonly table: string
}
/** Renames a table without changing its contents. */
export interface RenameTableOp extends OpBase {
  readonly _tag: "RenameTable"
  readonly from: string
  readonly to: string
}
/** Adds one column to an existing table. */
export interface AddColumnOp extends OpBase {
  readonly _tag: "AddColumn"
  readonly table: string
  readonly column: ColumnSpec
}
/** Drops a column and its stored values. */
export interface DropColumnOp extends OpBase {
  readonly _tag: "DropColumn"
  readonly table: string
  readonly column: string
}
/** Renames a column without changing its values. */
export interface RenameColumnOp extends OpBase {
  readonly _tag: "RenameColumn"
  readonly table: string
  readonly from: string
  readonly to: string
}
/** Changes a column's logical data type. */
export interface AlterColumnTypeOp extends OpBase {
  readonly _tag: "AlterColumnType"
  readonly table: string
  readonly column: string
  readonly to: SqlDataType
}
/** Adds a `NOT NULL` constraint. */
export interface SetNotNullOp extends OpBase {
  readonly _tag: "SetNotNull"
  readonly table: string
  readonly column: string
}
/** Removes a `NOT NULL` constraint. */
export interface DropNotNullOp extends OpBase {
  readonly _tag: "DropNotNull"
  readonly table: string
  readonly column: string
}
/** Trusted, unchecked SQL included directly in a migration plan. */
export interface RawSqlOp extends OpBase {
  readonly _tag: "RawSql"
  readonly sql: string
  readonly unchecked: true
}

/** Discriminated union compiled by each dialect's migration strategy. */
export type MigrationOperation =
  | CreateTableOp
  | DropTableOp
  | RenameTableOp
  | AddColumnOp
  | DropColumnOp
  | RenameColumnOp
  | AlterColumnTypeOp
  | SetNotNullOp
  | DropNotNullOp
  | RawSqlOp

/** A planned, guarded sequence of operations for one migration. */
export interface MigrationPlan {
  readonly id: string
  readonly name: string
  readonly operations: ReadonlyArray<MigrationOperation>
}
