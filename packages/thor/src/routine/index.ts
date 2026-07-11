/**
 * Declared scalar/aggregate functions, procedures, and table-valued functions.
 *
 * Routine names are parsed once into quoted identifiers, arguments remain
 * separately bound, capability requirements flow through Query IR, and return
 * codecs use the normal row-decoding pipeline.
 *
 * @module routine
 */
import { Effect, Schema } from "effect"
import {
  bitsToCapabilities,
  capabilitiesToBits,
  capabilityBit,
  type Capability,
  type CapabilityBits
} from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { Database } from "../execution/database.js"
import type { CommandResult, CompiledStatement } from "../execution/driver.js"
import { executeCommand, type QueryArgs } from "../execution/run.js"
import { isInTransaction } from "../execution/transaction.js"
import { GuardError, RoutineError, type QueryError } from "../errors/index.js"
import { internIdentifier } from "../ir/identifiers.js"
import { sourceIdentity } from "../ir/source-identity.js"
import { nextId, queryCapabilityBits, type CallIR, type ExprNode, type SelectionField } from "../ir/query-ir.js"
import { PostgresDialect } from "../postgres/dialect.js"
import type { SqlDataType } from "../schema/column.js"
import { windowable, type WindowableExpr } from "../sql/advanced-expressions.js"
import { toValueNodeWithCodec } from "../sql/expressions.js"
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
  readonly dataType: SqlDataType
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
   * @returns A typed routine-call expression, applicable over a window with `.over()`.
   */
  (...args: ReadonlyArray<unknown>): WindowableExpr<A>
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
  readonly call: (args: Readonly<Record<string, unknown>>, alias?: string) => QueryReference<Record<string, unknown>>
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
 * Binds named routine arguments to expression nodes in declared order, applying
 * each declared argument's codec and rejecting missing or unknown keys (Finding
 * 6) — so a missing argument never becomes a silent `undefined` and a typo is
 * not ignored.
 *
 * @param routine - Qualified routine name (for diagnostics).
 * @param declared - Declared argument specs keyed by name.
 * @param values - Application values keyed by argument name.
 * @returns Argument expression nodes in declared order.
 * @throws {RoutineError} When a declared argument is missing or an unknown key is supplied.
 */
const bindNamedArgs = (
  routine: string,
  declared: Readonly<Record<string, RoutineArg>>,
  values: Readonly<Record<string, unknown>>
): ExprNode[] => {
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(declared, key)) {
      throw new RoutineError({ routine, message: `Unknown argument "${key}" for routine "${routine}"` })
    }
  }
  return Object.entries(declared).map(([key, arg]) => {
    if (!Object.hasOwn(values, key)) {
      throw new RoutineError({ routine, message: `Missing argument "${key}" for routine "${routine}"` })
    }
    return toValueNodeWithCodec(values[key], arg.codec)
  })
}

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
  const call = ((...args: ReadonlyArray<unknown>): WindowableExpr<A> =>
    windowable<A>(
      {
        _tag: "FunctionCall",
        ...(name.schema ? { schema: name.schema } : {}),
        name: name.name,
        args: args.map((arg, i) => toValueNodeWithCodec(arg, spec.args[i]?.codec ?? Schema.Unknown)),
        aggregate,
        star: false,
        declared: true,
        volatility,
        capabilities
      },
      spec.returns.codec
    )) as FunctionRoutine<A>
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
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir)
  }

  /** @returns Capabilities required by this procedure call. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir))
  }

  /**
   * Execute the procedure, honoring its declared transaction requirement: a
   * procedure marked `requiresTransaction` fails before the driver when it is not
   * running inside a `db.transaction` scope (spec §14.5, §14.6).
   *
   * @param args - Values for named `param()` nodes embedded in call arguments.
   * @returns An Effect yielding the affected-row count.
   * @throws {GuardError} Through the Effect error channel when a required transaction is absent.
   */
  run(args: QueryArgs = {}): Effect.Effect<CommandResult, QueryError, Database> {
    return Effect.flatMap(Database, (database) => {
      if (this.ir.annotations.requiresTransaction && !isInTransaction(database)) {
        return Effect.fail(
          new GuardError({
            guard: "procedure-requires-transaction",
            message: `Procedure "${this.ir.schema ? `${this.ir.schema}.` : ""}${this.ir.procedure}" must be called inside a transaction (db.transaction)`
          })
        )
      }
      return executeCommand(this.ir, database, args)
    })
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
    call: (values: Readonly<Record<string, unknown>>): ProcedureCall =>
      new ProcedureCall({
        _tag: "Call",
        id: nextId("Call"),
        ...(name.schema ? { schema: name.schema } : {}),
        procedure: name.name,
        args: bindNamedArgs(name.name, spec.args, values),
        capabilities,
        cardinality: "zero",
        annotations: {
          tableNames: [...spec.effects.mutates],
          idempotency: spec.effects.idempotency,
          requiresTransaction: spec.effects.requiresTransaction
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
      const sourceId = sourceIdentity()
      const fields: SelectionField[] = Object.entries(spec.returns).map(([column, result]) => ({
        alias: internIdentifier(column),
        expr: {
          _tag: "ColumnRef",
          table: relationAlias,
          column: internIdentifier(column),
          dataType: result.dataType,
          sourceId
        },
        codec: result.codec
      }))
      return new QueryReference(
        {
          _tag: "TableFunctionSource",
          ...(name.schema ? { schema: name.schema } : {}),
          name: name.name,
          args: bindNamedArgs(name.name, spec.args, values),
          argTypes: Object.values(spec.args).map((argument) => argument.dataType),
          alias: relationAlias,
          columns: Object.keys(spec.returns).map(internIdentifier),
          capabilities,
          sourceId
        },
        fields
      )
    }
  })
}
