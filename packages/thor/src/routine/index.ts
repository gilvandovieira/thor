/**
 * Declared scalar/aggregate functions, procedures, and table-valued functions.
 *
 * Routine names are parsed once into quoted identifiers, arguments remain
 * separately bound, capability requirements flow through Query IR, and return
 * codecs use the normal row-decoding pipeline.
 *
 * @module routine
 */
import { Effect, type Schema } from "effect"
import {
  bitsToCapabilities,
  capabilitiesToBits,
  capabilityBit,
  type Capability,
  type CapabilityBits
} from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { Database } from "../execution/database.js"
import type { CommandResult, CompiledQuery } from "../execution/driver.js"
import { executeCommand, type QueryArgs } from "../execution/run.js"
import type { QueryError } from "../errors/index.js"
import { internIdentifier } from "../ir/identifiers.js"
import { nextId, queryCapabilityBits, type CallIR, type SelectionField } from "../ir/query-ir.js"
import { PostgresDialect } from "../postgres/dialect.js"
import type { PgDataType } from "../schema/column.js"
import { type Expr, toValueNode } from "../sql/expressions.js"
import { QueryReference } from "../sql/query-builder.js"

/** Volatility class (spec §12.2). Affects optimization and retry behavior. */
export type RoutineVolatility = "immutable" | "stable" | "volatile"

/** A qualified routine name whose identifiers are validated and interned. */
export interface RoutineName {
  readonly schema?: string
  readonly name: string
}

/** A typed routine argument. */
export interface RoutineArg<A = any> {
  readonly dataType: PgDataType
  readonly codec: Schema.Schema<A, any>
}

/** Declared metadata common to every routine kind. */
export interface RoutineMetadata {
  readonly name: RoutineName
  readonly volatility: RoutineVolatility
  readonly requires: ReadonlyArray<string>
  readonly capabilities: CapabilityBits
  readonly safeForPreparedStatement: boolean
}

/** Scalar or aggregate function descriptor. */
export interface FunctionDescriptor extends RoutineMetadata {
  readonly kind: "function"
  readonly aggregate: boolean
  readonly args: ReadonlyArray<RoutineArg>
  readonly returns: RoutineArg
}

/** Callable function descriptor producing typed expression IR. */
export interface FunctionRoutine<A = unknown> extends FunctionDescriptor {
  /**
   * @param args - Column, expression, parameter, or inline function arguments.
   * @returns A typed routine-call expression.
   */
  (...args: ReadonlyArray<unknown>): Expr<A>
}

/** Stored-procedure descriptor. */
export interface ProcedureDescriptor extends RoutineMetadata {
  readonly kind: "procedure"
  readonly args: Readonly<Record<string, RoutineArg>>
  readonly effects: {
    readonly mutates: ReadonlyArray<string>
    readonly idempotency: "idempotent" | "non-idempotent" | "unknown"
    readonly requiresTransaction: boolean
  }
}

/** Procedure descriptor with an executable call constructor. */
export interface ProcedureRoutine extends ProcedureDescriptor {
  /**
   * @param args - Application values keyed by declared argument name.
   * @returns An inspectable procedure-call command.
   */
  readonly call: (args: Readonly<Record<string, unknown>>) => ProcedureCall
}

/** Table-valued function descriptor. */
export interface TableFunctionDescriptor extends RoutineMetadata {
  readonly kind: "tableFunction"
  readonly args: Readonly<Record<string, RoutineArg>>
  readonly returns: Readonly<Record<string, RoutineArg>>
}

/** Table-valued function descriptor with a relation-source constructor. */
export interface TableFunctionRoutine extends TableFunctionDescriptor {
  /**
   * @param args - Application values keyed by declared argument name.
   * @param alias - Required query-local relation alias; defaults to the function name.
   * @returns A relation reference accepted by `from`, `join`, or `lateralJoin`.
   */
  readonly call: (
    args: Readonly<Record<string, unknown>>,
    alias?: string
  ) => QueryReference<Record<string, unknown>>
}

/** Shared declaration options for external capability requirements. */
export interface RoutineRequirements {
  /** External extension or deployment requirements retained for inspection. */
  readonly requires?: ReadonlyArray<string>
  /** Additional Thor capability requirements accumulated by calls. */
  readonly capabilities?: ReadonlyArray<Capability>
}

/**
 * Splits and interns a schema-qualified routine name.
 *
 * @param qualified - Routine name in `name` or `schema.name` form.
 * @returns Structured, safely interned name metadata.
 */
const parseName = (qualified: string): RoutineName => {
  const parts = qualified.split(".")
  return parts.length > 1
    ? {
        schema: internIdentifier(parts[0]!),
        name: internIdentifier(parts.slice(1).join("."))
      }
    : { name: internIdentifier(qualified) }
}

/**
 * @param base - Capability required by the routine kind.
 * @param extras - Additional declared capabilities.
 * @returns Encoded routine requirements.
 */
const routineCapabilities = (base: Capability, extras: ReadonlyArray<Capability> = []): CapabilityBits =>
  capabilityBit(base) | capabilitiesToBits(extras)

/**
 * Builds a callable scalar or aggregate function descriptor.
 *
 * @typeParam A - Decoded function return type.
 * @param qualifiedName - Declared `name` or `schema.name`.
 * @param spec - Arguments, return codec, volatility, and requirements.
 * @param aggregate - Whether grouping rules treat calls as aggregates.
 * @returns Callable descriptor producing function-call expression IR.
 */
const makeFunction = <A>(
  qualifiedName: string,
  spec: {
    readonly args: ReadonlyArray<RoutineArg>
    readonly returns: RoutineArg<A>
    readonly volatility?: RoutineVolatility
  } & RoutineRequirements,
  aggregate: boolean
): FunctionRoutine<A> => {
  const name = parseName(qualifiedName)
  const volatility = spec.volatility ?? "volatile"
  const capabilities = routineCapabilities("routine.functionCall", spec.capabilities)
  const call = ((...args: ReadonlyArray<unknown>): Expr<A> => ({
    node: {
      _tag: "FunctionCall",
      ...(name.schema ? { schema: name.schema } : {}),
      name: name.name,
      args: args.map((arg) => toValueNode(arg)),
      aggregate,
      star: false,
      declared: true,
      volatility,
      capabilities
    },
    codec: spec.returns.codec
  })) as FunctionRoutine<A>
  Object.assign(call, {
    kind: "function" as const,
    aggregate,
    args: spec.args,
    returns: spec.returns,
    volatility,
    requires: spec.requires ?? [],
    capabilities,
    safeForPreparedStatement: volatility !== "volatile"
  })
  Object.defineProperty(call, "name", { value: name, enumerable: true })
  return call
}

/**
 * Declares a callable scalar database function.
 *
 * @typeParam A - Decoded return type.
 * @param qualifiedName - `name` or `schema.name`; never emitted unchecked.
 * @param spec - Arguments, return codec, volatility, and external requirements.
 * @returns Callable scalar function metadata.
 */
export const defineFunction = <A = unknown>(
  qualifiedName: string,
  spec: {
    readonly args: ReadonlyArray<RoutineArg>
    readonly returns: RoutineArg<A>
    readonly volatility?: RoutineVolatility
  } & RoutineRequirements
): FunctionRoutine<A> => makeFunction(qualifiedName, spec, false)

/**
 * Declares a callable aggregate database function.
 *
 * @typeParam A - Decoded aggregate return type.
 * @param qualifiedName - `name` or `schema.name`.
 * @param spec - Arguments, return codec, volatility, and requirements.
 * @returns Callable aggregate function metadata.
 */
export const defineAggregateFunction = <A = unknown>(
  qualifiedName: string,
  spec: {
    readonly args: ReadonlyArray<RoutineArg>
    readonly returns: RoutineArg<A>
    readonly volatility?: RoutineVolatility
  } & RoutineRequirements
): FunctionRoutine<A> => makeFunction(qualifiedName, spec, true)

/** Inspectable, executable stored-procedure command. */
export class ProcedureCall {
  /**
   * @param ir - Procedure-call query representation.
   */
  constructor(readonly ir: CallIR) {}

  /** @returns Stable procedure metadata without execution. */
  inspect() {
    return {
      kind: this.ir._tag,
      procedure: this.ir.schema ? `${this.ir.schema}.${this.ir.procedure}` : this.ir.procedure,
      params: this.ir.args.length,
      capabilities: bitsToCapabilities(queryCapabilityBits(this.ir))
    }
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled `CALL` statement and parameters.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledQuery {
    return dialect.compileQuery(this.ir)
  }

  /** @returns Capabilities required by this procedure call. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir))
  }

  /**
   * @param args - Values for named `param()` nodes embedded in call arguments.
   * @returns An Effect yielding the affected-row count.
   */
  run(args: QueryArgs = {}): Effect.Effect<CommandResult, QueryError, Database> {
    return Effect.flatMap(Database, (database) => executeCommand(this.ir, database, args))
  }
}

/**
 * Declares an executable stored procedure.
 *
 * @param qualifiedName - `name` or `schema.name`.
 * @param spec - Named arguments, side effects, volatility, and requirements.
 * @returns Procedure metadata with a `.call()` constructor.
 */
export const defineProcedure = (
  qualifiedName: string,
  spec: {
    readonly args: Readonly<Record<string, RoutineArg>>
    readonly effects: ProcedureDescriptor["effects"]
    readonly volatility?: RoutineVolatility
  } & RoutineRequirements
): ProcedureRoutine => {
  const name = parseName(qualifiedName)
  const volatility = spec.volatility ?? "volatile"
  const capabilities = routineCapabilities("routine.procedureCall", spec.capabilities)
  const descriptor: ProcedureDescriptor = {
    kind: "procedure",
    name,
    args: spec.args,
    effects: spec.effects,
    volatility,
    requires: spec.requires ?? [],
    capabilities,
    safeForPreparedStatement: false
  }
  return Object.assign(descriptor, {
    call: (values: Readonly<Record<string, unknown>>): ProcedureCall => new ProcedureCall({
      _tag: "Call",
      id: nextId("Call"),
      ...(name.schema ? { schema: name.schema } : {}),
      procedure: name.name,
      args: Object.keys(spec.args).map((key) => toValueNode(values[key])),
      capabilities,
      cardinality: "zero",
      annotations: {
        tableNames: [...spec.effects.mutates],
        idempotency: spec.effects.idempotency
      }
    })
  })
}

/**
 * Declares a table-valued function usable as a relation source.
 *
 * @param qualifiedName - `name` or `schema.name`.
 * @param spec - Named arguments, returned columns, volatility, and requirements.
 * @returns Table-function metadata with a `.call()` relation constructor.
 */
export const defineTableFunction = (
  qualifiedName: string,
  spec: {
    readonly args: Readonly<Record<string, RoutineArg>>
    readonly returns: Readonly<Record<string, RoutineArg>>
    readonly volatility?: RoutineVolatility
  } & RoutineRequirements
): TableFunctionRoutine => {
  const name = parseName(qualifiedName)
  const volatility = spec.volatility ?? "stable"
  const capabilities = routineCapabilities("routine.tableValuedFunction", spec.capabilities)
  const descriptor: TableFunctionDescriptor = {
    kind: "tableFunction",
    name,
    args: spec.args,
    returns: spec.returns,
    volatility,
    requires: spec.requires ?? [],
    capabilities,
    safeForPreparedStatement: volatility !== "volatile"
  }
  return Object.assign(descriptor, {
    call: (values: Readonly<Record<string, unknown>>, alias = name.name): QueryReference<Record<string, unknown>> => {
      const relationAlias = internIdentifier(alias)
      const fields: SelectionField[] = Object.entries(spec.returns).map(([column, result]) => ({
        alias: internIdentifier(column),
        expr: {
          _tag: "ColumnRef",
          table: relationAlias,
          column: internIdentifier(column),
          dataType: result.dataType
        },
        codec: result.codec
      }))
      return new QueryReference(
        {
          _tag: "TableFunctionSource",
          ...(name.schema ? { schema: name.schema } : {}),
          name: name.name,
          args: Object.keys(spec.args).map((key) => toValueNode(values[key])),
          alias: relationAlias,
          columns: Object.keys(spec.returns).map(internIdentifier),
          capabilities
        },
        fields
      )
    }
  })
}
