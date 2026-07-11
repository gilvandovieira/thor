/**
 * Shared foundations for the fluent query builders (spec §4.1, §6).
 *
 * The select and mutation builders live in sibling modules; this leaf module
 * holds what both need — the cross-builder parameter/selection typing, the
 * selection-construction and inspection helpers, and the reusable
 * {@link PreparedQuery} handle — without importing either builder, so the
 * dependency graph stays acyclic.
 *
 * @module sql/query-builder-support
 */
import { Effect, type Option, Schema } from "effect"
import { type AnyColumn, type Column, columnParamCodec } from "../schema/column.js"
import { type AnyTable, tableMeta } from "../schema/table.js"
import {
  type QueryIR,
  type SelectIR,
  type SelectionField,
  collectQueryParams,
  queryCapabilityBits
} from "../ir/query-ir.js"
import { type Capability, bitsToCapabilities } from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"
import type { QueryError, NotFoundError, TooManyRowsError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import {
  executePreparedCommand,
  executePreparedMaybeOne,
  executePreparedOne,
  executePreparedRows,
  PreparedExecutionPlan,
  type QueryArgs
} from "../execution/run.js"
import type { CommandResult, CompiledStatement } from "../execution/driver.js"
import type { CompiledCardinality, TerminalResult } from "../execution/compiled-query.js"
import { internIdentifier } from "../ir/identifiers.js"
import { type Expr, columnRef, isColumn } from "./expressions.js"

// --- selection & parameter typing --------------------------------------------

/** Aliased output map: property names to selected columns or expressions. */
export type SelectFields = Record<string, AnyColumn | Expr<any>>

/** Resolves the decoded value type of a single selected column or expression. */
export type FieldValue<T> = T extends Column<infer C>
  ? C extends { readonly data: infer D }
    ? C extends { readonly notNull: true }
      ? D
      : D | null
    : unknown
  : T extends Expr<infer A>
    ? A
    : unknown

/** Row type produced by a selection field map. */
export type SelectResult<F extends SelectFields> = { [K in keyof F]: FieldValue<F[K]> } & {}

/** Map of named query parameters to their value types. */
export type NamedParams = Record<string, unknown>

/** Merges two parameter maps, with the right-hand side winning on key overlap. */
export type MergeParams<A extends NamedParams, B extends NamedParams> = {
  [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never
}

/** Terminal-method argument tuple: empty when the query has no parameters. */
export type ExecutionArguments<P extends NamedParams> = keyof P extends never
  ? [args?: Record<string, never>]
  : [args: { [K in keyof P]: P[K] }]

/** Either an execution-argument tuple or `[]` for compile-only terminals. */
export type TerminalArguments<P extends NamedParams> = ExecutionArguments<P> | []

/** Rejects argument tuples carrying keys the query never declared. */
export type ExactTerminalArguments<P extends NamedParams, Args extends TerminalArguments<P>> = Args extends []
  ? Args
  : Args extends [infer Input]
    ? Exclude<keyof Input, keyof P> extends never
      ? Args
      : never
    : never

/** Terminal result: a compilable value when called with `[]`, otherwise an executing Effect. */
export type TerminalCallResult<
  P extends NamedParams,
  Output,
  Error,
  Cardinality extends CompiledCardinality,
  Args extends TerminalArguments<P>
> = Args extends [] ? TerminalResult<P, Output, Error, Cardinality> : Effect.Effect<Output, Error, Database>

/**
 * @param args - Optional terminal-method argument tuple.
 * @returns The supplied named arguments or an empty map.
 */
export const argsFrom = (args: readonly [QueryArgs?]): QueryArgs => args[0] ?? {}

/**
 * Converts a selected column or expression into runtime selection metadata.
 *
 * @param alias - Output property name.
 * @param value - Selected column or expression.
 * @returns A field carrying the expression and row decoder.
 */
const toSelectionField = (alias: string, value: AnyColumn | Expr<any>): SelectionField => {
  const outputAlias = internIdentifier(alias)
  if (isColumn(value)) {
    return { alias: outputAlias, expr: columnRef(value), codec: columnParamCodec(value) }
  }
  const expression = value as Expr<any>
  return { alias: outputAlias, expr: expression.node, codec: expression.codec ?? Schema.Unknown }
}

/**
 * Converts an aliased field map into an ordered runtime selection.
 *
 * @param fields - Output aliases mapped to columns or expressions.
 * @returns Selection metadata in object insertion order.
 */
export const selectionFrom = (fields: SelectFields): SelectionField[] =>
  Object.entries(fields).map(([alias, value]) => toSelectionField(alias, value))

/**
 * Builds a star selection with one decoded field per table column.
 *
 * @param table - Table whose columns should be selected.
 * @returns Runtime selection metadata in declaration order.
 */
export const starSelection = (table: AnyTable): SelectionField[] =>
  Object.entries(tableMeta(table).columns).map(([alias, column]) => toSelectionField(alias, column))

// --- shared inspection -------------------------------------------------------

/**
 * Produces stable, serializable query metadata for diagnostics.
 *
 * `params` lists the named parameters that must be supplied at execution
 * (`execute()`/terminal args); `constants` lists inline-bound values captured in
 * the query shape (e.g. `eq(users.email, "x")`), which are validated and encoded
 * once and never enter the cache key (spec §8, P0.3). Distinguishing the two
 * makes clear which values a compiled handle still expects per call.
 *
 * @param ir - Query representation to inspect.
 * @returns Query kind, tables, named params, captured constants, cardinality, and capabilities.
 */
export const inspectIr = (ir: QueryIR) => {
  const all = collectQueryParams(ir)
  return {
    kind: ir._tag,
    tables: ir.annotations.tableNames,
    params: all.filter((parameter) => !("value" in parameter)).map((parameter) => parameter.name),
    constants: all.filter((parameter) => "value" in parameter).map((parameter) => parameter.name),
    cardinality: ir.cardinality,
    capabilities: bitsToCapabilities(queryCapabilityBits(ir)),
    operationName: ir.annotations.operationName,
    tracing: ir.annotations.tracing
  }
}

// --- PREPARED ----------------------------------------------------------------

/**
 * A precompiled, reusable query handle (spec §15.13, §15.15).
 *
 * `.prepare()` hoists per-call work out of the hot path: the IR is frozen, the
 * row decoder is precompiled at construction, and compilation + guarding are
 * memoized per dialect on first execution and reused thereafter. Values are
 * always bound separately per call — a handle never captures parameter values
 * (spec §15.17), so one handle serves every value combination.
 *
 * Hoist a handle to module scope for hot paths:
 * ```ts
 * const FindUserByEmail = db.select({ id: users.id }).from(users)
 *   .where(eq(users.email, param("email", Schema.String)))
 *   .prepare("FindUserByEmail")
 *
 * yield* FindUserByEmail.one({ email })
 * ```
 *
 * @experimental Prefer the v1 `CompiledQuery` API for new hot paths.
 */
export class PreparedQuery<A, P extends NamedParams = {}> {
  private readonly plan: PreparedExecutionPlan
  private readonly fields: SelectionField[]
  /** Lazily-built cardinality-probe plan capped to two rows (see `probePlan`). */
  private probePlanCache?: PreparedExecutionPlan

  /**
   * @param name - Stable handle name used in diagnostics and tracing.
   * @param ir - Frozen query representation.
   * @param fields - Runtime fields used to decode result rows.
   */
  constructor(
    readonly name: string,
    ir: QueryIR,
    fields: SelectionField[]
  ) {
    this.fields = fields
    this.plan = new PreparedExecutionPlan(
      {
        ...ir,
        annotations: {
          ...ir.annotations,
          operationName: name,
          tracing: {
            spanName: name,
            attributes: { "db.query.kind": ir._tag, "db.query.tables": ir.annotations.tableNames.join(",") }
          }
        }
      },
      fields
    )
  }

  /**
   * The cardinality-probe plan for `.one()`/`.maybeOne()`: a `SELECT` capped to
   * at most two rows (preserving any tighter user limit) so a prepared handle
   * never materializes an unbounded result set to decide cardinality (P0.5 /
   * Finding 5). Non-`SELECT` handles (or ones already ≤ 2) reuse the base plan.
   *
   * @returns The two-row-capped prepared plan.
   */
  private get probePlan(): PreparedExecutionPlan {
    if (this.probePlanCache) return this.probePlanCache
    const ir = this.plan.ir
    if (ir._tag === "Select") {
      const probe = Math.min((ir as SelectIR).limit ?? 2, 2)
      this.probePlanCache =
        (ir as SelectIR).limit === probe ? this.plan : new PreparedExecutionPlan({ ...ir, limit: probe }, this.fields)
    } else {
      this.probePlanCache = this.plan
    }
    return this.probePlanCache
  }

  /** @experimental Debugging shape only. @returns Stable query-shape metadata without compiling or executing. */
  inspect() {
    return { ...inspectIr(this.plan.ir), prepared: { name: this.name, ...this.plan.inspect() } }
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled SQL, parameter order, and cache key.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return this.plan.compile(dialect)
  }

  /** @returns Capabilities required to execute this handle. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(this.plan.capabilityBits)
  }

  /**
   * @stable
   * @param args - Values for named query parameters.
   * @returns An Effect yielding every decoded row.
   */
  all(...args: ExecutionArguments<P>): Effect.Effect<ReadonlyArray<A>, QueryError, Database> {
    return Effect.flatMap(Database, (db) => executePreparedRows<A>(this.plan, db, argsFrom(args)))
  }

  /**
   * @stable
   * @param args - Values for named query parameters.
   * @returns An Effect yielding exactly one decoded row.
   * @throws {NotFoundError} Through the Effect error channel when no row exists.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  one(...args: ExecutionArguments<P>): Effect.Effect<A, QueryError | NotFoundError | TooManyRowsError, Database> {
    return Effect.flatMap(Database, (db) =>
      executePreparedOne<A>(this.probePlan, db, argsFrom(args), `${this.name}.one`)
    )
  }

  /**
   * @stable
   * @param args - Values for named query parameters.
   * @returns An Effect yielding zero or one decoded row.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  maybeOne(...args: ExecutionArguments<P>): Effect.Effect<Option.Option<A>, QueryError | TooManyRowsError, Database> {
    return Effect.flatMap(Database, (db) =>
      executePreparedMaybeOne<A>(this.probePlan, db, argsFrom(args), `${this.name}.maybeOne`)
    )
  }

  /**
   * Execute as a command (for prepared mutations), returning the affected count.
   *
   * @stable
   * @param args - Values for named query parameters.
   * @returns An Effect yielding the affected-row count.
   */
  run(...args: ExecutionArguments<P>): Effect.Effect<CommandResult, QueryError, Database> {
    return Effect.flatMap(Database, (db) => executePreparedCommand(this.plan, db, argsFrom(args)))
  }
}
