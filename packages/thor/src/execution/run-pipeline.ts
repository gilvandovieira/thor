/**
 * Internal primitives of the runtime execution pipeline (spec §7.5, §9, §15):
 * parameter validation/encoding, the shape/compile/guard/decoder cache accesses,
 * mode-aware guarding and decoding, and prepared-statement bookkeeping. The
 * {@link module:execution/prepared-plan} handle and the {@link module:execution/run}
 * orchestrators both build on these; this leaf imports neither so the graph stays
 * acyclic.
 *
 * @module execution/run-pipeline
 */
import { Effect, Either, ParseResult, Schema } from "effect"
import { collectQueryParams, type ParamNode, type QueryIR, type SelectionField } from "../ir/query-ir.js"
import { collectViolations } from "../guards/query-guards.js"
import type { Dialect } from "../dialect.js"
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import { normalizeQuery } from "../ir/normalize.js"
import {
  type ConstraintError,
  DecodeError,
  type DriverError,
  ParameterError,
  type QueryError
} from "../errors/index.js"
import type { CompiledStatement, RawRow } from "./driver.js"
import { type DatabaseService } from "./database.js"
import { DEFAULT_EXECUTION_MODE, resolveDecodeMode } from "./plan.js"
import { defaultQueryCaches, type QueryCaches } from "./cache.js"
import { type QueryCacheOutcome, type QueryObservationState } from "../observability/index.js"

/**
 * The named query cache registry backing a service's non-prepared execution
 * path: the one installed by `withQueryCache`, or the process-wide default
 * (spec §9.1). Prepared handles (Epic D) keep their own per-handle caches.
 *
 * @param db - Active database service.
 * @returns The service's query caches, or the shared default.
 */
export const cachesFor = (db: DatabaseService): QueryCaches => db.queryCache ?? defaultQueryCaches

/** Named values supplied to `param()` placeholders at execution time. */
export type QueryArgs = Record<string, unknown>

type ParameterEncoder = (value: unknown) => Either.Either<unknown, ParseResult.ParseError>

interface NamedParameter {
  readonly node: ParamNode
  readonly encode: ParameterEncoder
}

/** Compiled validation/encoding plan for a query's named parameters. */
export class ParameterPlan {
  private readonly named = new Map<string, NamedParameter>()
  /**
   * Inline-bound values, encoded once through their declared column/param codec.
   * Keyed by node identity — the same node objects appear in the compiled
   * `paramOrder`. This closes the P0.2 gap where inline values (e.g.
   * `eq(users.email, "x")`) previously bypassed the codec that named
   * `param()` values were validated and encoded through.
   */
  private readonly inline = new Map<ParamNode, unknown>()
  private readonly failure: ParameterError | undefined

  /**
   * @param params - Query parameters collected in placeholder order.
   */
  constructor(params: ReadonlyArray<ParamNode>) {
    let failure: ParameterError | undefined
    for (const node of params) {
      if (Object.prototype.hasOwnProperty.call(node, "value")) {
        // Inline literal: validate and encode through its codec, once.
        if (this.inline.has(node)) continue
        const result = (Schema.encodeUnknownEither(node.codec) as ParameterEncoder)(node.value)
        if (Either.isLeft(result)) {
          failure ??= new ParameterError({
            parameter: node.name,
            reason: "invalid",
            message: `Invalid inline value for "${node.name}": ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
            cause: result.left
          })
        } else {
          this.inline.set(node, result.right)
        }
        continue
      }
      const existing = this.named.get(node.name)
      if (existing) {
        if (existing.node === node) continue
        const reason = existing.node.codec === node.codec ? "duplicate" : "conflict"
        failure ??= new ParameterError({
          parameter: node.name,
          reason,
          message:
            reason === "conflict"
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
        return Effect.fail(
          new ParameterError({
            parameter: name,
            reason: "missing",
            message: `Missing required named parameter "${name}"`
          })
        )
      }
    }
    for (const name of Object.keys(args)) {
      if (!this.named.has(name)) {
        return Effect.fail(
          new ParameterError({
            parameter: name,
            reason: "extra",
            message: `Unexpected named parameter "${name}"`
          })
        )
      }
    }

    const encoded = new Map<string, unknown>()
    for (const [name, parameter] of this.named) {
      const result = parameter.encode(args[name])
      if (Either.isLeft(result)) {
        return Effect.fail(
          new ParameterError({
            parameter: name,
            reason: "invalid",
            message: `Invalid value for named parameter "${name}": ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
            cause: result.left
          })
        )
      }
      encoded.set(name, result.right)
    }

    // Inline nodes were validated and encoded at construction (a failure would
    // have short-circuited above via `this.failure`); named nodes resolve from
    // the just-encoded execution args. Both go through their declared codec.
    return Effect.succeed(
      paramOrder.map((node) =>
        Object.prototype.hasOwnProperty.call(node, "value") ? this.inline.get(node) : encoded.get(node.name)
      )
    )
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
export const shapeVia = (caches: QueryCaches, ir: QueryIR): QueryIR =>
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
export const compileVia = (caches: QueryCaches, ir: QueryIR, dialect: Dialect): CompiledStatement => {
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
export const guardForMode = (
  caches: QueryCaches,
  ir: QueryIR,
  db: DatabaseService
): Effect.Effect<void, QueryError> => {
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
export const decodeForMode = (
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
 * @param ir - Query owning the parameter codecs.
 * @param paramOrder - Parameter nodes in compiled placeholder order.
 * @param args - Named values supplied at execution time.
 * @returns Positional values ready for the driver.
 */
export const bindValues = (
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
export const preparedNameFor = (db: DatabaseService, compiled: CompiledStatement): string | undefined =>
  db.preparedStatements && compiled.paramOrder.length > 0 ? compiled.cacheKey : undefined

/**
 * @param caches - Active query caches.
 * @param ir - Normalized query shape.
 * @param dialect - Target SQL dialect.
 * @returns Whether dialect SQL is already retained in the compile cache.
 */
export const hasCompiled = (caches: QueryCaches, ir: QueryIR, dialect: Dialect): boolean =>
  (caches.compile.peek(ir) as Map<Dialect, CompiledStatement> | undefined)?.has(dialect) ?? false

const preparedByDriver = new WeakMap<object, Map<string, string>>()

/**
 * @param driver - Active driver.
 * @returns The object owning the connection's prepared statements (the physical
 * connection when the adapter exposes one, otherwise the driver instance).
 */
const preparedScopeOf = (driver: { readonly preparedScope?: object }): object => driver.preparedScope ?? driver

/** Prepared identity and observation outcome selected for one execution. */
export interface PreparedExecution {
  /** Name passed to the driver, or undefined for unprepared execution. */
  readonly name: string | undefined
  /** Actual connection-scoped prepared-registry outcome. */
  readonly outcome: QueryCacheOutcome
}

/**
 * Record prepared-shape reuse once and return its per-execution outcome.
 *
 * @param db - Active database service.
 * @param caches - Active query caches.
 * @param compiled - Compiled query shape.
 * @returns The observed prepared-cache outcome.
 */
export const prepareForExecution = (
  db: DatabaseService,
  caches: QueryCaches,
  compiled: CompiledStatement
): Effect.Effect<PreparedExecution, DriverError | ConstraintError> =>
  Effect.gen(function* () {
    const requested = preparedNameFor(db, compiled)
    if (!requested) return { name: undefined, outcome: "not-used" }
    const scope = preparedScopeOf(db.driver)
    let prepared = preparedByDriver.get(scope)
    if (!prepared) {
      prepared = new Map()
      preparedByDriver.set(scope, prepared)
    }
    const priorSql = prepared.get(requested)
    if (priorSql === compiled.sql) {
      prepared.delete(requested)
      prepared.set(requested, compiled.sql)
      if (db.recordPreparedCache !== false) caches.notePrepared("hit", prepared.size, false)
      return { name: requested, outcome: db.recordPreparedCache === false ? "not-used" : "hit" }
    }
    if (priorSql !== undefined) {
      if (db.recordPreparedCache !== false) caches.notePrepared("miss", prepared.size, false)
      return { name: undefined, outcome: db.recordPreparedCache === false ? "not-used" : "miss" }
    }

    let evicted = false
    const maxSize = caches.preparedMaxSize
    if (maxSize !== undefined && prepared.size >= maxSize) {
      const oldest = prepared.keys().next().value as string | undefined
      if (!oldest || !db.driver.releasePrepared) {
        if (db.recordPreparedCache !== false) caches.notePrepared("miss", prepared.size, false)
        return { name: undefined, outcome: db.recordPreparedCache === false ? "not-used" : "miss" }
      }
      // Remove the registry entry before yielding so a concurrent fiber cannot
      // pick the same victim; a release failure is housekeeping, not a reason to
      // fail the user's unrelated query, so it is observed and swallowed.
      prepared.delete(oldest)
      yield* Effect.ignore(db.driver.releasePrepared(oldest))
      evicted = true
    }

    prepared.set(requested, compiled.sql)
    if (db.recordPreparedCache !== false) caches.notePrepared("miss", prepared.size, evicted)
    return { name: requested, outcome: db.recordPreparedCache === false ? "not-used" : "miss" }
  })

/** @returns Fresh mutable facts scoped to one execution. */
export const observationState = (): QueryObservationState => ({
  compileCache: "not-used",
  preparedCache: "not-used"
})

/** Synchronous decoder mapping a raw driver row to a decoded record or a parse error. */
export type RowDecoder = (raw: RawRow) => Either.Either<Record<string, unknown>, ParseResult.ParseError>

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
export const rowDecoderFor = (fields: ReadonlyArray<SelectionField>): RowDecoder =>
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
  return new DecodeError({
    message: `Failed to decode row: ${ParseResult.TreeFormatter.formatErrorSync(rowError)}`,
    cause: rowError
  })
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
export const decodeRows = (
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
