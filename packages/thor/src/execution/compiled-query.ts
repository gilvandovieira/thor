/**
 * Stable executable compiled-query handles (v1 spec §8).
 *
 * A handle owns a validated query shape, dialect SQL, parameter plan, and row
 * decoder. Bound values are accepted only by `execute`, so neither SQL nor cache
 * identity can depend on user input.
 *
 * @module execution/compiled-query
 */
import { Effect } from "effect"
import { bitsToCapabilities, type Capability } from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { CompileError } from "../errors/index.js"
import type { QueryIR, SelectionField } from "../ir/query-ir.js"
import { PostgresDialect } from "../postgres/dialect.js"
import { Database, type DatabaseService } from "./database.js"
import type { CompiledStatement } from "./driver.js"
import type { CanonicalExecutionMode } from "./plan.js"
import { PreparedExecutionPlan, type QueryArgs } from "./run.js"

type NamedParams = Record<string, unknown>
type ExecutionArguments<P extends NamedParams> = keyof P extends never
  ? [args?: Record<string, never>]
  : [args: { [K in keyof P]: P[K] }]

/** Cardinality contract selected by a terminal query method. */
export type CompiledCardinality = "all" | "one" | "maybeOne" | "run"

/**
 * Per-compile precompilation options (spec §9.3, §9.4).
 *
 * A compiled handle owns its validated shape, SQL, parameter plan and decoder, so
 * it is already the fully-cached hot path. These options tune the two remaining
 * knobs at execution time without changing the query API shape.
 *
 * @stable
 */
export interface CompileOptions {
  /**
   * Record cache-layer prepared-reuse counters for this handle's executions
   * (spec §9). Defaults to `true`; set `false` to keep executions out of the
   * observed cache statistics.
   */
  readonly cache?: boolean
  /**
   * Force server-side prepared-statement reuse on (`true`) or off (`false`),
   * overriding the service policy (spec §9.4 `compilePrepared`). Defaults to
   * inheriting the active `Database` policy.
   */
  readonly prepare?: boolean
  /**
   * Override the execution mode for this handle (spec §10). `unsafe-hot` skips
   * row decoding and must be opted into explicitly (spec §10.3); capability
   * guards are always retained. Defaults to inheriting the active mode.
   *
   * @experimental Modes containing unsafe-hot are outside the stable safety boundary.
   */
  readonly mode?: CanonicalExecutionMode
}

/**
 * A stable, executable query shape (v1 spec §8.3).
 *
 * @stable
 * @typeParam Params - Named values accepted by {@link execute}.
 * @typeParam Output - Successful execution result.
 * @typeParam Error - Tagged failures exposed through the Effect error channel.
 * @typeParam Requirements - Effect services required for execution.
 * @typeParam D - Dialect used to compile the SQL shape.
 * @typeParam Cardinality - Terminal cardinality contract.
 */
export interface CompiledQuery<
  Params extends NamedParams,
  Output,
  Error,
  Requirements,
  D extends Dialect,
  Cardinality extends CompiledCardinality
> {
  /** Stable dialect/profile/shape key; never includes parameter values. */
  readonly cacheKey: string
  /** Dialect used to lower and validate this query shape. */
  readonly dialect: D
  /** Terminal result contract selected before compilation. */
  readonly cardinality: Cardinality
  /** Capabilities required by this query shape. */
  readonly capabilities: ReadonlySet<Capability>

  /**
   * Binds per-call values and executes the retained query plan.
   *
   * @stable
   * @param args - Named values for this execution only.
   * @returns An Effect yielding the terminal query result.
   */
  execute(...args: ExecutionArguments<Params>): Effect.Effect<Output, Error, Requirements>
}

/** An Effect terminal that can also be frozen into a stable compiled handle. */
export type CompilableEffect<
  Params extends NamedParams,
  Output,
  Error,
  Cardinality extends CompiledCardinality
> = Effect.Effect<Output, Error, Database> & {
  /**
   * Validates and compiles this query shape for one dialect (spec §9.4).
   *
   * @stable
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @param options - Per-compile precompilation options.
   * @returns A reusable executable handle.
   */
  compile<D extends Dialect = typeof PostgresDialect>(
    dialect?: D,
    options?: CompileOptions
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
  /**
   * Compiles and forces server-side prepared-statement reuse where the driver
   * supports it (spec §9.4 `compilePrepared`).
   *
   * @stable
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @returns A reusable executable handle that prepares.
   */
  compilePrepared<D extends Dialect = typeof PostgresDialect>(
    dialect?: D
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
  /**
   * Compiles for the `unsafe-hot` path: prepared and decode-skipping, an explicit
   * opt-in for already validated queries (spec §9.4 `compileUnsafeHot`, §10.3).
   * Capability guards are still enforced.
   *
   * @experimental Unsafe-hot behavior is explicitly outside the stable safety boundary.
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @returns A reusable executable handle running in `unsafe-hot` mode.
   */
  compileUnsafeHot<D extends Dialect = typeof PostgresDialect>(
    dialect?: D
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
}

/** A shape-only terminal returned when a parameterized query omits execution values. */
export interface CompilableTerminal<
  Params extends NamedParams,
  Output,
  Error,
  Cardinality extends CompiledCardinality
> {
  /**
   * Validates and compiles this query shape for one dialect (spec §9.4).
   *
   * @stable
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @param options - Per-compile precompilation options.
   * @returns A reusable executable handle.
   */
  compile<D extends Dialect = typeof PostgresDialect>(
    dialect?: D,
    options?: CompileOptions
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
  /**
   * Compiles and forces server-side prepared-statement reuse where the driver
   * supports it (spec §9.4 `compilePrepared`).
   *
   * @stable
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @returns A reusable executable handle that prepares.
   */
  compilePrepared<D extends Dialect = typeof PostgresDialect>(
    dialect?: D
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
  /**
   * Compiles for the `unsafe-hot` path: prepared and decode-skipping, an explicit
   * opt-in for already validated queries (spec §9.4 `compileUnsafeHot`, §10.3).
   * Capability guards are still enforced.
   *
   * @experimental Unsafe-hot behavior is explicitly outside the stable safety boundary.
   * @typeParam D - Selected dialect type.
   * @param dialect - Target dialect; defaults to PostgreSQL.
   * @returns A reusable executable handle running in `unsafe-hot` mode.
   */
  compileUnsafeHot<D extends Dialect = typeof PostgresDialect>(
    dialect?: D
  ): CompiledQuery<Params, Output, Error, Database, D, Cardinality>
}

/** A no-argument terminal remains directly executable only when it has no named parameters. */
export type TerminalResult<
  Params extends NamedParams,
  Output,
  Error,
  Cardinality extends CompiledCardinality
> = keyof Params extends never
  ? CompilableEffect<Params, Output, Error, Cardinality>
  : CompilableTerminal<Params, Output, Error, Cardinality>

type CompiledExecutor<Output, Error> = (
  plan: PreparedExecutionPlan,
  statement: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs
) => Effect.Effect<Output, Error>

class CompiledQueryImpl<
  Params extends NamedParams,
  Output,
  Error,
  D extends Dialect,
  Cardinality extends CompiledCardinality
> implements CompiledQuery<Params, Output, Error, Database, D, Cardinality>
{
  readonly cacheKey: string
  readonly capabilities: ReadonlySet<Capability>
  private readonly dialectId: string
  private readonly profileHash: string

  /**
   * @param plan - Validated shape, parameter, and decoder plan.
   * @param statement - Retained dialect SQL and placeholder order.
   * @param dialect - Dialect used to compile the statement.
   * @param cardinality - Terminal cardinality contract.
   * @param executor - Terminal-specific hot-path execution function.
   * @param options - Per-compile precompilation options (mode/prepare/cache).
   */
  constructor(
    private readonly plan: PreparedExecutionPlan,
    private readonly statement: CompiledStatement,
    readonly dialect: D,
    readonly cardinality: Cardinality,
    private readonly executor: CompiledExecutor<Output, Error>,
    private readonly options: CompileOptions = {}
  ) {
    this.cacheKey = statement.cacheKey
    this.capabilities = new Set(bitsToCapabilities(plan.capabilityBits))
    this.dialectId = dialect.id
    this.profileHash = dialect.profileHash
  }

  /**
   * Apply this handle's `mode`/`prepare` options to the active service so the
   * shared executors observe the requested policy without new signatures.
   *
   * @param db - Active database service.
   * @returns The service, or a policy-overridden copy.
   */
  private applyPolicy(db: DatabaseService): DatabaseService {
    const { cache, mode, prepare } = this.options
    if (mode === undefined && prepare === undefined && cache !== false) return db
    const next: DatabaseService = { ...db, recordPreparedCache: cache !== false }
    if (mode !== undefined) {
      // Drop any inherited explicit decode override so decode derives from mode.
      const mutable = next as { mode: typeof mode; decodeMode?: unknown }
      mutable.mode = mode
      delete mutable.decodeMode
    }
    if (prepare !== undefined) (next as { preparedStatements: boolean }).preparedStatements = prepare
    return next
  }

  /**
   * @stable
   * @param args - Named values for this execution only.
   * @returns An Effect yielding the terminal query result.
   */
  execute(...args: ExecutionArguments<Params>): Effect.Effect<Output, Error, Database> {
    return Effect.flatMap(Database, (db) => {
      if (db.dialect.id !== this.dialectId || db.dialect.profileHash !== this.profileHash) {
        return Effect.fail(
          new CompileError({
            message: `Compiled query targets dialect profile "${this.dialectId}:${this.profileHash}" but execution provided "${db.dialect.id}:${db.dialect.profileHash}"`
          })
        ) as unknown as Effect.Effect<Output, Error>
      }

      const service = this.applyPolicy(db)
      const failure = this.plan.guard(service.dialect, service.allowEmulation)
      if (failure) return Effect.fail(failure) as unknown as Effect.Effect<Output, Error>
      return this.executor(this.plan, this.statement, service, args[0] ?? {})
    })
  }
}

/**
 * Adds lazy `.compile()` support to an existing direct-execution terminal Effect.
 * The expensive plan is created only when compilation is requested.
 *
 * @internal
 * @typeParam Params - Named execution parameter map.
 * @typeParam Output - Terminal success value.
 * @typeParam Error - Terminal error union.
 * @typeParam Cardinality - Terminal cardinality contract.
 * @param effect - Existing direct-execution Effect.
 * @param ir - Immutable query shape to retain.
 * @param fields - Selection codecs used by row-returning terminals.
 * @param cardinality - Terminal result contract.
 * @param executor - Hot-path execution function for this terminal.
 * @returns The same Effect with a shape-only compile method.
 */
export const compilableEffect = <Params extends NamedParams, Output, Error, Cardinality extends CompiledCardinality>(
  effect: Effect.Effect<Output, Error, Database>,
  ir: QueryIR,
  fields: ReadonlyArray<SelectionField>,
  cardinality: Cardinality,
  executor: CompiledExecutor<Output, Error>
): CompilableEffect<Params, Output, Error, Cardinality> => {
  const build = <D extends Dialect>(dialect: D, options: CompileOptions) => {
    const plan = new PreparedExecutionPlan(ir, fields)
    const failure = plan.guard(dialect, false)
    if (failure) throw failure
    const statement = plan.compile(dialect)
    return new CompiledQueryImpl<Params, Output, Error, D, Cardinality>(
      plan,
      statement,
      dialect,
      cardinality,
      executor,
      options
    )
  }
  return Object.assign(effect, {
    compile: <D extends Dialect = typeof PostgresDialect>(
      dialect: D = PostgresDialect as D,
      options: CompileOptions = {}
    ) => build(dialect, options),
    compilePrepared: <D extends Dialect = typeof PostgresDialect>(dialect: D = PostgresDialect as D) =>
      build(dialect, { prepare: true }),
    compileUnsafeHot: <D extends Dialect = typeof PostgresDialect>(dialect: D = PostgresDialect as D) =>
      build(dialect, { prepare: true, mode: "unsafe-hot" })
  })
}
