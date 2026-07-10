/**
 * The runtime execution pipeline (spec §7.5):
 *   guard → capability check → compile → bind → execute → decode → cardinality.
 *
 * @module execution/run
 */
import { Effect, Either, Option, ParseResult, Schema } from "effect"
import { collectQueryParams, queryCapabilityBits, type ParamNode, type QueryIR, type SelectionField } from "../ir/query-ir.js"
import {
  collectCapabilityViolations,
  collectStructuralViolations,
  collectViolations
} from "../guards/query-guards.js"
import type { Dialect } from "../dialect.js"
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import type { CapabilityBits } from "../capabilities/capability.js"
import { queryStructuralHash } from "../ir/structural-hash.js"
import { normalizeQuery } from "../ir/normalize.js"
import { DecodeError, GuardError, NotFoundError, ParameterError, type QueryError, TooManyRowsError } from "../errors/index.js"
import type { CommandResult, CompiledStatement, RawRow } from "./driver.js"
import { type DatabaseService } from "./database.js"
import { DEFAULT_EXECUTION_MODE, resolveDecodeMode } from "./plan.js"
import { defaultQueryCaches, type QueryCaches } from "./cache.js"

/**
 * The named query cache registry backing a service's non-prepared execution
 * path: the one installed by `withQueryCache`, or the process-wide default
 * (spec §9.1). Prepared handles (Epic D) keep their own per-handle caches.
 *
 * @param db - Active database service.
 * @returns The service's query caches, or the shared default.
 */
const cachesFor = (db: DatabaseService): QueryCaches => db.queryCache ?? defaultQueryCaches

/** Named values supplied to `param()` placeholders at execution time. */
export type QueryArgs = Record<string, unknown>

type ParameterEncoder = (value: unknown) => Either.Either<unknown, ParseResult.ParseError>

interface NamedParameter {
  readonly node: ParamNode
  readonly encode: ParameterEncoder
}

/** Compiled validation/encoding plan for a query's named parameters. */
class ParameterPlan {
  private readonly named = new Map<string, NamedParameter>()
  private readonly failure: ParameterError | undefined

  /**
   * @param params - Query parameters collected in placeholder order.
   */
  constructor(params: ReadonlyArray<ParamNode>) {
    let failure: ParameterError | undefined
    for (const node of params) {
      if (Object.prototype.hasOwnProperty.call(node, "value")) continue
      const existing = this.named.get(node.name)
      if (existing) {
        if (existing.node === node) continue
        const reason = existing.node.codec === node.codec ? "duplicate" : "conflict"
        failure ??= new ParameterError({
          parameter: node.name,
          reason,
          message: reason === "conflict"
            ? `Named parameter "${node.name}" was declared with conflicting schemas`
            : `Named parameter "${node.name}" was declared more than once; reuse the same param() value`
        })
        continue
      }
      this.named.set(node.name, {
        node,
        encode: Schema.encodeUnknownEither(node.codec) as ParameterEncoder
      })
    }
    this.failure = failure
  }

  /**
   * @param paramOrder - Compiled placeholder order, including repeated references.
   * @param args - Untrusted named execution arguments.
   * @returns Encoded positional driver values or a tagged validation failure.
   */
  bind(paramOrder: ReadonlyArray<ParamNode>, args: QueryArgs): Effect.Effect<ReadonlyArray<unknown>, ParameterError> {
    if (this.failure) return Effect.fail(this.failure)

    for (const name of this.named.keys()) {
      if (!Object.prototype.hasOwnProperty.call(args, name)) {
        return Effect.fail(new ParameterError({
          parameter: name,
          reason: "missing",
          message: `Missing required named parameter "${name}"`
        }))
      }
    }
    for (const name of Object.keys(args)) {
      if (!this.named.has(name)) {
        return Effect.fail(new ParameterError({
          parameter: name,
          reason: "extra",
          message: `Unexpected named parameter "${name}"`
        }))
      }
    }

    const encoded = new Map<string, unknown>()
    for (const [name, parameter] of this.named) {
      const result = parameter.encode(args[name])
      if (Either.isLeft(result)) {
        return Effect.fail(new ParameterError({
          parameter: name,
          reason: "invalid",
          message: `Invalid value for named parameter "${name}": ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
          cause: result.left
        }))
      }
      encoded.set(name, result.right)
    }

    return Effect.succeed(paramOrder.map((node) =>
      Object.prototype.hasOwnProperty.call(node, "value") ? node.value : encoded.get(node.name)
    ))
  }
}

const parameterPlanCache = new WeakMap<QueryIR, ParameterPlan>()

/**
 * @param ir - Stable query shape.
 * @returns Its cached parameter validation and encoding plan.
 */
const parameterPlanFor = (ir: QueryIR): ParameterPlan => {
  let plan = parameterPlanCache.get(ir)
  if (!plan) {
    plan = new ParameterPlan(collectQueryParams(ir))
    parameterPlanCache.set(ir, plan)
  }
  return plan
}

/**
 * Normalize an IR shape through the {@link QueryCaches.shape} layer (spec §9.1).
 * Compilation and guarding then operate on the normalized shape, matching the
 * prepared/compiled handle path so every execution route shares one canonical
 * shape identity.
 *
 * @param caches - Active cache registry.
 * @param ir - Immutable builder query representation.
 * @returns The cached normalized IR.
 */
const shapeVia = (caches: QueryCaches, ir: QueryIR): QueryIR =>
  caches.shape.getOrCompute(ir, () => normalizeQuery(ir)) as QueryIR

/**
 * Compile a normalized shape once per dialect through the
 * {@link QueryCaches.compile} layer.
 *
 * The runtime IR is immutable and compilation is a pure function of
 * `(IR, dialect)`, so a query executed N times (with different bound values each
 * time) pays the compile cost once — later executions are just bind + drive +
 * decode.
 *
 * @param caches - Active cache registry.
 * @param ir - Normalized query representation.
 * @param dialect - Target SQL dialect.
 * @returns The cached or newly compiled statement.
 */
const compileVia = (caches: QueryCaches, ir: QueryIR, dialect: Dialect): CompiledStatement => {
  const byDialect = caches.compile.getOrCompute(ir, () => new Map<Dialect, CompiledStatement>())
  let compiled = byDialect.get(dialect)
  if (compiled === undefined) {
    compiled = dialect.compileQuery(ir)
    byDialect.set(dialect, compiled)
  }
  return compiled
}

type GuardByPolicy = Map<boolean, QueryError | null>
type GuardByMatrix = Map<CapabilityMatrix, GuardByPolicy>

/**
 * Reads a previously computed guard outcome through the capability layer without
 * recording a computation.
 *
 * @param caches - Active cache registry.
 * @param ir - Normalized query representation.
 * @param matrix - Dialect capability matrix.
 * @param allowEmulation - Emulation policy.
 * @returns Cached failure, `null` for cached success, or `undefined` when absent.
 */
const cachedGuardResult = (
  caches: QueryCaches,
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation: boolean
): QueryError | null | undefined =>
  (caches.capability.peek(ir) as GuardByMatrix | undefined)?.get(matrix)?.get(allowEmulation)

/**
 * Guards IR and memoizes the outcome per shape and capability policy through the
 * {@link QueryCaches.capability} layer.
 *
 * @param caches - Active cache registry.
 * @param ir - Normalized query representation to guard.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns An Effect that fails with the first violation or succeeds with void.
 */
const guardCached = (
  caches: QueryCaches,
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation: boolean
): Effect.Effect<void, QueryError> => {
  const byMatrix = caches.capability.getOrCompute(ir, () => new Map()) as GuardByMatrix
  let byPolicy = byMatrix.get(matrix)
  if (!byPolicy) {
    byPolicy = new Map()
    byMatrix.set(matrix, byPolicy)
  }

  if (!byPolicy.has(allowEmulation)) {
    const violations = collectViolations(ir, matrix, allowEmulation)
    byPolicy.set(allowEmulation, violations[0] ?? null)
  }
  const failure = byPolicy.get(allowEmulation) ?? null
  return failure === null ? Effect.void : Effect.fail(failure)
}

/**
 * Mode-aware guard (spec §10, §15.13, §15.17). `safe` always guards (memoized).
 * `trusted`/`unsafe-hot` skip the guard only when a prior success is already
 * recorded for this exact shape + capability profile + emulation policy — so
 * capability checks are never bypassed without a recorded prior pass (§15.17);
 * otherwise the guard runs once (and records the result).
 *
 * @param caches - Active cache registry.
 * @param ir - Normalized query representation to guard.
 * @param db - Active database service (carries dialect + execution mode).
 * @returns An Effect that fails with the first violation or succeeds with void.
 */
const guardForMode = (caches: QueryCaches, ir: QueryIR, db: DatabaseService): Effect.Effect<void, QueryError> => {
  const matrix = db.dialect.capabilities
  if ((db.mode ?? DEFAULT_EXECUTION_MODE) === "safe") return guardCached(caches, ir, matrix, db.allowEmulation)
  if (cachedGuardResult(caches, ir, matrix, db.allowEmulation) === null) {
    return Effect.void
  }
  return guardCached(caches, ir, matrix, db.allowEmulation)
}

/**
 * Decode rows honoring the active decode mode: `trusted` (from the `unsafe-hot`
 * execution mode) returns raw driver rows untouched; otherwise strict schema
 * decoding runs.
 *
 * @param caches - Active cache registry backing the decoder layer.
 * @param fields - Selection fields and codecs.
 * @param rows - Raw driver rows.
 * @param db - Active database service.
 * @param decoder - Optional precompiled decoder (used by prepared handles).
 * @returns An Effect yielding rows, decoded or trusted per mode.
 */
const decodeForMode = (
  caches: QueryCaches,
  fields: ReadonlyArray<SelectionField>,
  rows: ReadonlyArray<RawRow>,
  db: DatabaseService,
  decoder?: RowDecoder
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DecodeError> =>
  resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    ? Effect.succeed(rows as ReadonlyArray<Record<string, unknown>>)
    : decodeRows(fields, rows, decoder ?? decoderVia(caches, fields))

/**
 * Resolves positional bind values for a compiled query.
 *
 * @param paramOrder - Parameter nodes in compiled placeholder order.
 * @param args - Named values supplied at execution time.
 * @param ir - Query owning the parameter codecs.
 * @returns Positional values ready for the driver.
 */
const bindValues = (
  ir: QueryIR,
  paramOrder: ReadonlyArray<ParamNode>,
  args: QueryArgs
): Effect.Effect<ReadonlyArray<unknown>, ParameterError> => parameterPlanFor(ir).bind(paramOrder, args)

/**
 * The prepared-statement name for a compiled query, or undefined to run it
 * unprepared. Only parameterized statements are prepared (param-free statements
 * may be multi-statement DDL, which cannot be prepared).
 *
 * @param db - Active database service and execution policy.
 * @param compiled - Compiled query metadata.
 * @returns Prepared statement name, or `undefined` for direct execution.
 */
const preparedNameFor = (db: DatabaseService, compiled: CompiledStatement): string | undefined =>
  db.preparedStatements && compiled.paramOrder.length > 0 ? compiled.cacheKey : undefined

type RowDecoder = (raw: RawRow) => Either.Either<Record<string, unknown>, ParseResult.ParseError>

/**
 * Compiles a struct decoder for a selection. Compiling the decoder is the
 * expensive part of Effect Schema; doing it once per query shape — instead of
 * once per field per row — is the difference between microseconds and
 * milliseconds on bulk reads. Callers cache the result in the decoder layer.
 *
 * @param fields - Selected fields and their codecs.
 * @returns A synchronous decoder for raw rows.
 */
const buildRowDecoder = (fields: ReadonlyArray<SelectionField>): RowDecoder => {
  const struct: Record<string, Schema.Schema<unknown, unknown>> = {}
  for (const field of fields) struct[field.alias] = field.codec as Schema.Schema<unknown, unknown>
  return Schema.decodeUnknownEither(Schema.Struct(struct)) as RowDecoder
}

/**
 * Resolve (and cache) the row decoder for a selection through the
 * {@link QueryCaches.decoder} layer.
 *
 * @param caches - Active cache registry.
 * @param fields - Selected fields and their codecs.
 * @returns A synchronous decoder for raw rows.
 */
const decoderVia = (caches: QueryCaches, fields: ReadonlyArray<SelectionField>): RowDecoder =>
  caches.decoder.getOrCompute(fields, () => buildRowDecoder(fields)) as RowDecoder

/**
 * Precompile (and cache) the row decoder for a selection ahead of execution,
 * through the process-wide default decoder layer. Prepared query handles call
 * this at construction so the decoder plan is paid once, at prepare time, not on
 * the first read (spec §15.15).
 *
 * @param fields - Selected fields and their codecs.
 * @returns A synchronous decoder for raw rows.
 */
const rowDecoderFor = (fields: ReadonlyArray<SelectionField>): RowDecoder =>
  decoderVia(defaultQueryCaches, fields)

/**
 * Pinpoint the offending field on the (rare) decode-failure path so the error
 * names the exact column. Kept off the hot path — the fast loop never runs this.
 *
 * @param fields - Selected fields and codecs.
 * @param raw - Raw row that failed decoding.
 * @param rowError - Aggregate struct decoding failure.
 * @returns A field-specific decode error when possible.
 */
const describeFailure = (
  fields: ReadonlyArray<SelectionField>,
  raw: RawRow,
  rowError: ParseResult.ParseError
): DecodeError => {
  for (const field of fields) {
    const result = Schema.decodeUnknownEither(field.codec)(raw[field.alias])
    if (Either.isLeft(result)) {
      return new DecodeError({
        message: `Failed to decode field "${field.alias}": ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
        cause: result.left
      })
    }
  }
  return new DecodeError({ message: `Failed to decode row: ${ParseResult.TreeFormatter.formatErrorSync(rowError)}`, cause: rowError })
}

/**
 * Decode every row through a single precompiled decoder in a tight synchronous
 * loop — no per-field/per-row Effect allocation.
 *
 * @param fields - Selected fields and codecs.
 * @param rows - Raw driver rows.
 * @param decode - Precompiled decoder; resolved from `fields` when omitted.
 * @returns An Effect yielding decoded records or a `DecodeError`.
 */
const decodeRows = (
  fields: ReadonlyArray<SelectionField>,
  rows: ReadonlyArray<RawRow>,
  decode: RowDecoder = rowDecoderFor(fields)
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DecodeError> => {
  const out = new Array<Record<string, unknown>>(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const result = decode(rows[i]!)
    if (Either.isLeft(result)) return Effect.fail(describeFailure(fields, rows[i]!, result.left))
    out[i] = result.right
  }
  return Effect.succeed(out)
}

/** One dialect-profile validation recorded by a prepared handle. */
export interface PreparedDialectInspection {
  /** Dialect identifier. */
  readonly dialect: string
  /** Stable capability-profile hash. */
  readonly profileHash: string
  /** Whether emulated capabilities were allowed. */
  readonly allowEmulation: boolean
  /** Cached guard result. */
  readonly guard: "passed" | "failed"
  /** Compiled query key when the guard passed or `toSql()` compiled the shape. */
  readonly cacheKey?: string
}

/** Serializable metadata precomputed or recorded by a prepared execution plan. */
export interface PreparedPlanInspection {
  /** Dialect-independent, value-independent IR hash. */
  readonly structuralHash: string
  /** Capability bits accumulated by the builder. */
  readonly capabilityBits: CapabilityBits
  /** Named parameters in compiler traversal order. */
  readonly params: ReadonlyArray<string>
  /** Shape-only guard result computed at preparation time. */
  readonly structuralGuard: "passed" | "failed"
  /** Dialect profiles compiled or validated so far. */
  readonly dialects: ReadonlyArray<PreparedDialectInspection>
}

interface CachedCompilation {
  readonly profileHash: string
  readonly compiled: CompiledStatement
}

interface CachedGuard {
  readonly profileHash: string
  readonly failure: QueryError | null
}

/**
 * Takes a stable, shallowly frozen snapshot of query IR for a prepared handle.
 * Builder-produced expression nodes are already immutable; arrays and statement
 * records are copied so later builder activity cannot alter the handle.
 *
 * @param ir - Builder query representation.
 * @returns Frozen query-shape snapshot.
 */
const snapshotQuery = (ir: QueryIR): QueryIR => {
  const annotations = Object.freeze({ ...ir.annotations, tableNames: Object.freeze([...ir.annotations.tableNames]) })
  switch (ir._tag) {
    case "Select":
      return Object.freeze({
        ...ir,
        from: Object.freeze({ ...ir.from }),
        selection: Object.freeze([...ir.selection]),
        orderBy: Object.freeze([...ir.orderBy]),
        annotations
      })
    case "Insert":
      return Object.freeze({
        ...ir,
        into: Object.freeze({ ...ir.into }),
        columns: Object.freeze([...ir.columns]),
        rows: Object.freeze(ir.rows.map((row) => Object.freeze([...row]))),
        ...(ir.returning ? { returning: Object.freeze([...ir.returning]) } : {}),
        annotations
      })
    case "Update":
      return Object.freeze({
        ...ir,
        table: Object.freeze({ ...ir.table }),
        set: Object.freeze([...ir.set]),
        ...(ir.returning ? { returning: Object.freeze([...ir.returning]) } : {}),
        annotations
      })
    case "Delete":
      return Object.freeze({
        ...ir,
        from: Object.freeze({ ...ir.from }),
        ...(ir.returning ? { returning: Object.freeze([...ir.returning]) } : {}),
        annotations
      })
    case "Call":
      return Object.freeze({
        ...ir,
        args: Object.freeze([...ir.args]),
        annotations
      })
  }
}

/**
 * Per-handle execution plan with compile and guard caches scoped by dialect.
 *
 * The constructor performs all dialect-independent work. Dialect-specific work
 * is performed once on first use and keyed by dialect object, capability
 * profile, and emulation policy.
 */
export class PreparedExecutionPlan {
  readonly ir: QueryIR
  readonly structuralHash: string
  readonly capabilityBits: CapabilityBits
  readonly params: ReadonlyArray<string>

  private readonly fields: ReadonlyArray<SelectionField>
  private readonly decoder: RowDecoder
  private readonly structuralFailure: QueryError | null
  private readonly parameterPlan: ParameterPlan
  private readonly compilations = new WeakMap<Dialect, CachedCompilation>()
  private readonly guards = new WeakMap<Dialect, Map<boolean, CachedGuard>>()
  private readonly dialectInspections = new Map<string, PreparedDialectInspection>()

  /**
   * @param ir - Immutable builder query representation.
   * @param fields - Selection fields used by the decoder plan.
   * @throws {GuardError} When the query captures inline parameter values.
   */
  constructor(ir: QueryIR, fields: ReadonlyArray<SelectionField>) {
    const params = collectQueryParams(ir)
    const captured = params.find((parameter) => "value" in parameter)
    if (captured) {
      throw new GuardError({
        guard: "prepared-values",
        message: `Prepared queries cannot capture value for parameter "${captured.name}"; use param(name, schema) and pass the value at execution`
      })
    }

    this.ir = normalizeQuery(snapshotQuery(ir))
    this.fields = Object.freeze([...fields])
    this.decoder = rowDecoderFor(this.fields)
    this.structuralHash = queryStructuralHash(this.ir)
    this.capabilityBits = queryCapabilityBits(this.ir)
    this.params = Object.freeze(params.map((parameter) => parameter.name))
    this.structuralFailure = collectStructuralViolations(this.ir)[0] ?? null
    this.parameterPlan = new ParameterPlan(collectQueryParams(this.ir))
  }

  /**
   * Compiles this handle once for a dialect capability profile.
   *
   * @param dialect - Target SQL dialect.
   * @returns Cached or newly compiled query data.
   */
  compile(dialect: Dialect): CompiledStatement {
    const profileHash = dialect.profileHash
    const cached = this.compilations.get(dialect)
    if (cached?.profileHash === profileHash) return cached.compiled

    const compiled = dialect.compileQuery(this.ir)
    this.compilations.set(dialect, { profileHash, compiled })
    for (const [allowEmulation, guard] of this.guards.get(dialect) ?? []) {
      if (guard.profileHash === profileHash) {
        this.recordDialect(dialect, profileHash, allowEmulation, guard.failure)
      }
    }
    return compiled
  }

  /**
   * Returns the cached guard result for a dialect profile and policy.
   *
   * @param dialect - Active SQL dialect.
   * @param allowEmulation - Whether emulated capabilities may execute.
   * @returns The first cached violation, or `null` when validation passed.
   */
  guard(dialect: Dialect, allowEmulation: boolean): QueryError | null {
    const profileHash = dialect.profileHash
    let byPolicy = this.guards.get(dialect)
    if (!byPolicy) {
      byPolicy = new Map()
      this.guards.set(dialect, byPolicy)
    }

    const cached = byPolicy.get(allowEmulation)
    if (cached?.profileHash === profileHash) {
      this.recordDialect(dialect, profileHash, allowEmulation, cached.failure)
      return cached.failure
    }

    const failure = this.structuralFailure ??
      collectCapabilityViolations(this.ir, dialect.capabilities, allowEmulation)[0] ?? null
    byPolicy.set(allowEmulation, { profileHash, failure })
    this.recordDialect(dialect, profileHash, allowEmulation, failure)
    return failure
  }

  /**
   * Decodes raw rows through the precompiled decoder plan.
   *
   * @param rows - Raw driver rows.
   * @returns An Effect yielding decoded records.
   */
  decode(rows: ReadonlyArray<RawRow>): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DecodeError> {
    return decodeRows(this.fields, rows, this.decoder)
  }

  /**
   * @param paramOrder - Compiled placeholder order.
   * @param args - Untrusted named execution arguments.
   * @returns Encoded positional values or a tagged parameter failure.
   */
  bind(paramOrder: ReadonlyArray<ParamNode>, args: QueryArgs): Effect.Effect<ReadonlyArray<unknown>, ParameterError> {
    return this.parameterPlan.bind(paramOrder, args)
  }

  /** @returns Precomputed shape metadata and cached dialect-profile outcomes. */
  inspect(): PreparedPlanInspection {
    return {
      structuralHash: this.structuralHash,
      capabilityBits: this.capabilityBits,
      params: this.params,
      structuralGuard: this.structuralFailure ? "failed" : "passed",
      dialects: [...this.dialectInspections.values()]
    }
  }

  /**
   * Records an observable dialect-profile guard result.
   *
   * @param dialect - Validated dialect.
   * @param profileHash - Capability-profile identity.
   * @param allowEmulation - Emulation policy used by the guard.
   * @param failure - Cached failure, or `null` on success.
   * @returns Nothing.
   */
  private recordDialect(
    dialect: Dialect,
    profileHash: string,
    allowEmulation: boolean,
    failure: QueryError | null
  ): void {
    const compiled = this.compilations.get(dialect)
    const key = `${dialect.id}:${profileHash}:${allowEmulation}`
    this.dialectInspections.set(key, {
      dialect: dialect.id,
      profileHash,
      allowEmulation,
      guard: failure ? "failed" : "passed",
      ...(compiled?.profileHash === profileHash ? { cacheKey: compiled.compiled.cacheKey } : {})
    })
  }
}

/**
 * Executes a prepared row-returning plan with per-call values.
 *
 * @typeParam A - Decoded row shape.
 * @param plan - Precomputed execution plan.
 * @param db - Active database service.
 * @param args - Named parameter values for this call only.
 * @returns An Effect yielding decoded rows.
 */
export const executePreparedRows = <A>(
  plan: PreparedExecutionPlan,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<ReadonlyArray<A>, QueryError> => {
  const failure = plan.guard(db.dialect, db.allowEmulation)
  if (failure) return Effect.fail(failure)

  const compiled = plan.compile(db.dialect)
  const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
  return Effect.flatMap(plan.bind(compiled.paramOrder, args), (values) =>
    Effect.flatMap(db.driver.query(compiled.sql, values, preparedNameFor(db, compiled)), (rows) =>
      trusted ? Effect.succeed(rows as ReadonlyArray<A>) : (plan.decode(rows) as Effect.Effect<ReadonlyArray<A>, DecodeError>)
    )
  )
}

/**
 * Executes a prepared command plan with per-call values.
 *
 * @param plan - Precomputed execution plan.
 * @param db - Active database service.
 * @param args - Named parameter values for this call only.
 * @returns An Effect yielding the affected-row count.
 */
export const executePreparedCommand = (
  plan: PreparedExecutionPlan,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<CommandResult, QueryError> => {
  const failure = plan.guard(db.dialect, db.allowEmulation)
  if (failure) return Effect.fail(failure)

  const compiled = plan.compile(db.dialect)
  return Effect.flatMap(plan.bind(compiled.paramOrder, args), (values) =>
    db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
  )
}

/**
 * Executes rows through an already compiled plan without guard traversal or SQL
 * compilation. Public compiled-query handles perform their cheap dialect-profile
 * check before entering this path.
 *
 * @typeParam A - Decoded row shape.
 * @param plan - Precomputed shape, parameter, and decoder plan.
 * @param compiled - SQL compiled when the public handle was created.
 * @param db - Active database service.
 * @param args - Named values supplied for this execution only.
 * @returns An Effect yielding decoded rows.
 */
export const executeCompiledRows = <A>(
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<ReadonlyArray<A>, QueryError> => {
  const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
  return Effect.flatMap(plan.bind(compiled.paramOrder, args), (values) =>
    Effect.flatMap(db.driver.query(compiled.sql, values, preparedNameFor(db, compiled)), (rows) =>
      trusted ? Effect.succeed(rows as ReadonlyArray<A>) : (plan.decode(rows) as Effect.Effect<ReadonlyArray<A>, DecodeError>)
    )
  )
}

/**
 * Executes a command through an already compiled plan without guard traversal
 * or SQL compilation.
 *
 * @param plan - Precomputed shape and parameter plan.
 * @param compiled - SQL compiled when the public handle was created.
 * @param db - Active database service.
 * @param args - Named values supplied for this execution only.
 * @returns An Effect yielding the affected-row count.
 */
export const executeCompiledCommand = (
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<CommandResult, QueryError> =>
  Effect.flatMap(plan.bind(compiled.paramOrder, args), (values) =>
    db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
  )

/**
 * Guards, compiles, binds, executes, and decodes a row-returning query.
 *
 * @typeParam A - Decoded row shape.
 * @param ir - Immutable runtime query representation.
 * @param fields - Selection fields and codecs used to decode each row.
 * @param db - Active database service.
 * @param args - Named parameter values.
 * @returns An Effect yielding decoded rows or a typed query error.
 */
export const executeRows = <A>(
  ir: QueryIR,
  fields: ReadonlyArray<SelectionField>,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<ReadonlyArray<A>, QueryError> =>
  Effect.gen(function* () {
    const caches = cachesFor(db)
    const shape = shapeVia(caches, ir)
    yield* guardForMode(caches, shape, db)
    const compiled = compileVia(caches, shape, db.dialect)
    const values = yield* bindValues(shape, compiled.paramOrder, args)
    const prepared = preparedNameFor(db, compiled)
    if (prepared) caches.notePrepared(prepared)
    const rows = yield* db.driver.query(compiled.sql, values, prepared)
    return (yield* decodeForMode(caches, fields, rows, db)) as ReadonlyArray<A>
  })

/**
 * Guards, compiles, binds, and executes a command without row decoding.
 *
 * @param ir - Immutable runtime query representation.
 * @param db - Active database service.
 * @param args - Named parameter values.
 * @returns An Effect yielding the affected-row count.
 */
export const executeCommand = (
  ir: QueryIR,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<CommandResult, QueryError> =>
  Effect.gen(function* () {
    const caches = cachesFor(db)
    const shape = shapeVia(caches, ir)
    yield* guardForMode(caches, shape, db)
    const compiled = compileVia(caches, shape, db.dialect)
    const values = yield* bindValues(shape, compiled.paramOrder, args)
    const prepared = preparedNameFor(db, compiled)
    if (prepared) caches.notePrepared(prepared)
    return yield* db.driver.execute(compiled.sql, values, prepared)
  })

// --- cardinality refinements (spec §6.5) ------------------------------------

/**
 * Refines a row collection to exactly one value.
 *
 * @typeParam A - Row value type.
 * @param rows - Rows to refine.
 * @param operation - Human-readable operation name included in errors.
 * @returns An Effect yielding the only row.
 * @throws {NotFoundError} Through the Effect error channel when no rows exist.
 * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
 */
export const exactlyOne = <A>(
  rows: ReadonlyArray<A>,
  operation: string
): Effect.Effect<A, NotFoundError | TooManyRowsError> => {
  if (rows.length === 0) return Effect.fail(new NotFoundError({ message: `${operation}: expected one row, found none` }))
  if (rows.length > 1)
    return Effect.fail(new TooManyRowsError({ count: rows.length, message: `${operation}: expected one row, found ${rows.length}` }))
  return Effect.succeed(rows[0]!)
}

/**
 * Refines a row collection to zero or one value.
 *
 * @typeParam A - Row value type.
 * @param rows - Rows to refine.
 * @param operation - Human-readable operation name included in errors.
 * @returns `Option.none()` for no rows or `Option.some(row)` for one row.
 * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
 */
export const atMostOne = <A>(
  rows: ReadonlyArray<A>,
  operation: string
): Effect.Effect<Option.Option<A>, TooManyRowsError> => {
  if (rows.length > 1)
    return Effect.fail(new TooManyRowsError({ count: rows.length, message: `${operation}: expected at most one row, found ${rows.length}` }))
  return Effect.succeed(rows.length === 0 ? Option.none() : Option.some(rows[0]!))
}
