/**
 * Thor's tagged error model (spec §10).
 *
 * Every failure mode is a `Data.TaggedError` so callers can discriminate with
 * `Effect.catchTag("ConstraintError", ...)`. We never throw generic exceptions
 * where a meaningful tagged error can exist.
 *
 * @module errors
 */
import { Data } from "effect"
import type { Capability } from "../capabilities/capability.js"
import type { DialectId } from "../capabilities/matrix.js"
import type { RuntimeCapability, RuntimeId } from "../capabilities/runtime.js"

/** A capability required by an operation is not `native` (and no emulation was enabled). */
export class CapabilityError extends Data.TaggedError("CapabilityError")<{
  readonly capability: Capability
  readonly dialect: DialectId
  readonly message: string
}> {}

/** A driver adapter cannot run with the host's available runtime capabilities. */
export class RuntimeCapabilityError extends Data.TaggedError("RuntimeCapabilityError")<{
  readonly adapter: string
  readonly runtime: RuntimeId
  readonly required: ReadonlyArray<RuntimeCapability>
  readonly missing: ReadonlyArray<RuntimeCapability>
  readonly message: string
}> {}

/** The runtime IR could not be lowered to dialect SQL. */
export class CompileError extends Data.TaggedError("CompileError")<{
  readonly message: string
  readonly detail?: unknown
}> {}

/** The underlying driver rejected the statement (connection, syntax, protocol...). */
export class DriverError extends Data.TaggedError("DriverError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A database constraint (unique, fk, check, not-null) was violated. */
export class ConstraintError extends Data.TaggedError("ConstraintError")<{
  readonly constraint: string
  readonly kind: "unique" | "foreignKey" | "check" | "notNull" | "unknown"
  readonly message: string
  readonly cause?: unknown
}> {}

/** A row failed to decode through its declared codec. */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** `.one()` found zero rows. */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string
}> {}

/** `.one()` / `.maybeOne()` found more than one row. */
export class TooManyRowsError extends Data.TaggedError("TooManyRowsError")<{
  readonly count: number
  readonly message: string
}> {}

/** A guard rejected an operation during construction or before execution. */
export class GuardError extends Data.TaggedError("GuardError")<{
  readonly guard: string
  readonly message: string
}> {}

/** Migration planning or execution failed. */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly message: string
  readonly migrationId?: string
  readonly cause?: unknown
}> {}

/** An irreversible migration's `down` was requested. */
export class IrreversibleMigrationError extends Data.TaggedError("IrreversibleMigrationError")<{
  readonly message: string
  readonly migrationId?: string
}> {}

/** Transaction lifecycle problem (nested without savepoints, escaped scope...). */
export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A statement exceeded its deadline / was interrupted. */
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string
}> {}

/** A routine (function/procedure) call failed. */
export class RoutineError extends Data.TaggedError("RoutineError")<{
  readonly routine: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** Union of every Thor error. */
export type ThorError =
  | CapabilityError
  | RuntimeCapabilityError
  | CompileError
  | DriverError
  | ConstraintError
  | DecodeError
  | NotFoundError
  | TooManyRowsError
  | GuardError
  | MigrationError
  | IrreversibleMigrationError
  | TransactionError
  | TimeoutError
  | RoutineError

/** Errors that can surface from executing a query (before cardinality refinement). */
export type QueryError =
  | GuardError
  | CapabilityError
  | CompileError
  | DriverError
  | ConstraintError
  | DecodeError
