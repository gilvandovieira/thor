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

/** Whether a routine is a value-returning function or a called procedure. */
export type RoutineKind = "function" | "procedure"

/** A routine argument. `type` is trusted dialect SQL type text (never interpolated user data). */
export interface RoutineArgSpec {
  readonly name?: string
  readonly type: string
}

/**
 * Creates a stored function or procedure (spec §14, §15.1). Routine bodies are
 * inherently dialect-specific PL code, so `returns`, `language`, and `body` carry
 * trusted SQL text — treat them like `unsafeSql`, never request data.
 */
export interface CreateRoutineOp extends OpBase {
  readonly _tag: "CreateRoutine"
  readonly routine: RoutineKind
  readonly name: string
  readonly args: ReadonlyArray<RoutineArgSpec>
  /** Return type SQL for functions; ignored for procedures. */
  readonly returns?: string
  /** Routine language (e.g. `sql`, `plpgsql`). */
  readonly language: string
  /** Trusted routine body. */
  readonly body: string
  /** Emit `CREATE OR REPLACE` where the dialect supports it. */
  readonly replace?: boolean
}

/** Drops a stored function or procedure. */
export interface DropRoutineOp extends OpBase {
  readonly _tag: "DropRoutine"
  readonly routine: RoutineKind
  readonly name: string
  /** Argument types for overload disambiguation where the dialect requires them. */
  readonly args?: ReadonlyArray<RoutineArgSpec>
  readonly ifExists?: boolean
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
  | CreateRoutineOp
  | DropRoutineOp

/** A planned, guarded sequence of operations for one migration. */
export interface MigrationPlan {
  readonly id: string
  readonly name: string
  readonly operations: ReadonlyArray<MigrationOperation>
}

/**
 * The expand/contract phase of an operation (spec §15.5). An **expand** step
 * adds new structures or relaxes constraints without breaking code still using
 * the old shape; a **contract** step drops, renames, retypes, or requires
 * something and can break old code, so it is gated more strictly.
 *
 * @param op - Migration operation.
 * @returns `"expand"` for additive/non-breaking steps, `"contract"` otherwise.
 */
export const migrationPhase = (op: MigrationOperation): "expand" | "contract" => {
  switch (op._tag) {
    case "CreateTable":
    case "DropNotNull":
    case "CreateRoutine":
      return "expand"
    case "AddColumn": {
      // Adding a required column breaks old inserts; a unique one can collide on
      // existing rows. A nullable column, or one with a default, is safe to add.
      const { nullable, default: dflt, unique } = op.column
      return !unique && (nullable || dflt !== undefined) ? "expand" : "contract"
    }
    case "RenameTable":
    case "RenameColumn":
    case "AlterColumnType":
    case "SetNotNull":
    case "DropColumn":
    case "DropTable":
    case "DropRoutine":
    case "RawSql":
      return "contract"
  }
}

/**
 * @param op - Migration operation.
 * @returns Whether the operation is an expand-phase (additive, non-breaking) step.
 */
export const isExpandOperation = (op: MigrationOperation): boolean => migrationPhase(op) === "expand"
