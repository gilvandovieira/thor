/**
 * Routines: functions, procedures, table-valued functions (spec §12).
 *
 * Routine safety invariant (§18.3): routine names are declared, never
 * interpolated from unchecked strings; every routine carries typed metadata
 * (arg/return types, volatility, side effects, capabilities) so the runtime can
 * enforce safe execution.
 *
 * v0 status: the metadata/IR model and safe declaration surface are implemented.
 * Expression/`from`-clause wiring (FunctionCall/TableFunction lowering) lands
 * with Milestone 9 — the descriptors below are already the source of truth.
 *
 * @module routine
 */
import type { Schema } from "effect"
import type { CapabilityBits } from "../capabilities/capability.js"
import type { PgDataType } from "../schema/column.js"

/** Volatility class (spec §12.2). Affects optimization and retry behavior. */
export type RoutineVolatility = "immutable" | "stable" | "volatile"

/** A qualified routine name — schema is explicit, never string-interpolated. */
export interface RoutineName {
  readonly schema?: string
  readonly name: string
}

/** A typed routine argument. */
export interface RoutineArg {
  readonly dataType: PgDataType
  readonly codec: Schema.Schema<any, any>
}

/** Declared metadata common to all routines (spec §12.2). */
export interface RoutineMetadata {
  readonly name: RoutineName
  readonly volatility: RoutineVolatility
  readonly requires: ReadonlyArray<string>
  readonly capabilities: CapabilityBits
  readonly safeForPreparedStatement: boolean
}

/** Scalar function descriptor (spec §12.1–12.3). */
export interface FunctionDescriptor extends RoutineMetadata {
  readonly kind: "function"
  readonly args: ReadonlyArray<RoutineArg>
  readonly returns: RoutineArg
}

/** Procedure descriptor (spec §12.4–12.5). */
export interface ProcedureDescriptor extends RoutineMetadata {
  readonly kind: "procedure"
  readonly args: Readonly<Record<string, RoutineArg>>
  readonly effects: {
    readonly mutates: ReadonlyArray<string>
    readonly idempotency: "idempotent" | "non-idempotent" | "unknown"
    readonly requiresTransaction: boolean
  }
}

/** Table-valued function descriptor (spec §12.6). */
export interface TableFunctionDescriptor extends RoutineMetadata {
  readonly kind: "tableFunction"
  readonly args: Readonly<Record<string, RoutineArg>>
  readonly returns: Readonly<Record<string, RoutineArg>>
}

/**
 * Splits a possibly schema-qualified routine name.
 *
 * @param qualified - Routine name in `name` or `schema.name` form.
 * @returns Structured routine name metadata.
 */
const parseName = (qualified: string): RoutineName => {
  const parts = qualified.split(".")
  return parts.length > 1 ? { schema: parts[0]!, name: parts.slice(1).join(".") } : { name: qualified }
}

/**
 * Declares a scalar database function.
 *
 * @param qualifiedName - `name` or `schema.name`; parsed without SQL interpolation.
 * @param spec - Arguments, return type, volatility, and external requirements.
 * @returns Immutable scalar function metadata.
 */
export const defineFunction = (
  qualifiedName: string,
  spec: {
    readonly args: ReadonlyArray<RoutineArg>
    readonly returns: RoutineArg
    readonly volatility?: RoutineVolatility
    readonly requires?: ReadonlyArray<string>
  }
): FunctionDescriptor => ({
  kind: "function",
  name: parseName(qualifiedName),
  args: spec.args,
  returns: spec.returns,
  volatility: spec.volatility ?? "volatile",
  requires: spec.requires ?? [],
  capabilities: 0n,
  safeForPreparedStatement: (spec.volatility ?? "volatile") !== "volatile"
})

/**
 * Declares a stored procedure.
 *
 * @param qualifiedName - `name` or `schema.name`.
 * @param spec - Named arguments, side effects, volatility, and requirements.
 * @returns Immutable procedure metadata.
 */
export const defineProcedure = (
  qualifiedName: string,
  spec: {
    readonly args: Readonly<Record<string, RoutineArg>>
    readonly effects: ProcedureDescriptor["effects"]
    readonly volatility?: RoutineVolatility
    readonly requires?: ReadonlyArray<string>
  }
): ProcedureDescriptor => ({
  kind: "procedure",
  name: parseName(qualifiedName),
  args: spec.args,
  effects: spec.effects,
  volatility: spec.volatility ?? "volatile",
  requires: spec.requires ?? [],
  capabilities: 0n,
  safeForPreparedStatement: false
})

/**
 * Declares a table-valued function.
 *
 * @param qualifiedName - `name` or `schema.name`.
 * @param spec - Named arguments, returned columns, volatility, and requirements.
 * @returns Immutable table-function metadata.
 */
export const defineTableFunction = (
  qualifiedName: string,
  spec: {
    readonly args: Readonly<Record<string, RoutineArg>>
    readonly returns: Readonly<Record<string, RoutineArg>>
    readonly volatility?: RoutineVolatility
    readonly requires?: ReadonlyArray<string>
  }
): TableFunctionDescriptor => ({
  kind: "tableFunction",
  name: parseName(qualifiedName),
  args: spec.args,
  returns: spec.returns,
  volatility: spec.volatility ?? "stable",
  requires: spec.requires ?? [],
  capabilities: 0n,
  safeForPreparedStatement: true
})
