/**
 * The runtime execution pipeline (spec §7.5):
 *   guard → capability check → compile → bind → execute → decode → cardinality.
 *
 * @module execution/run
 */
import { Effect, Either, Option, ParseResult, Schema } from "effect"
import { collectQueryParams, type ParamNode, type QueryIR, type SelectionField } from "../ir/query-ir.js"
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
import { DecodeError, GuardError, NotFoundError, type QueryError, TooManyRowsError } from "../errors/index.js"
import type { CommandResult, CompiledQuery, RawRow } from "./driver.js"
import { type DatabaseService } from "./database.js"
import { DEFAULT_EXECUTION_MODE, resolveDecodeMode } from "./plan.js"

/** Named values supplied to `param()` placeholders at execution time. */
export type QueryArgs = Record<string, unknown>

/**
 * The runtime IR is immutable and compilation/guarding are pure functions of
 * `(IR, dialect)`, so we memoize both per query shape. A query executed N times
 * (with different bound values each time) pays the compile + guard cost once —
 * every later execution is just bind + drive + decode.
 */
const compileCache = new WeakMap<QueryIR, WeakMap<Dialect, CompiledQuery>>()

/**
 * Compiles a query once for each IR and dialect object pair.
 *
 * @param ir - Immutable query representation.
 * @param dialect - Target SQL dialect.
 * @returns The cached or newly compiled query.
 */
const compileCached = (ir: QueryIR, dialect: Dialect): CompiledQuery => {
  let byDialect = compileCache.get(ir)
  if (byDialect === undefined) {
    byDialect = new WeakMap()
    compileCache.set(ir, byDialect)
  }
  let compiled = byDialect.get(dialect)
  if (compiled === undefined) {
    compiled = dialect.compileQuery(ir)
    byDialect.set(dialect, compiled)
  }
  return compiled
}

type GuardPolicyCache = Map<boolean, QueryError | null>
const guardCache = new WeakMap<QueryIR, WeakMap<CapabilityMatrix, GuardPolicyCache>>()

/**
 * Reads a previously computed guard outcome without creating cache entries.
 *
 * @param ir - Query representation.
 * @param matrix - Dialect capability matrix.
 * @param allowEmulation - Emulation policy.
 * @returns Cached failure, `null` for cached success, or `undefined` when absent.
 */
const cachedGuardResult = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation: boolean
): QueryError | null | undefined => guardCache.get(ir)?.get(matrix)?.get(allowEmulation)

/**
 * Guards IR and memoizes the outcome per shape and capability policy.
 *
 * @param ir - Query representation to guard.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns An Effect that fails with the first violation or succeeds with void.
 */
const guardCached = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation: boolean
): Effect.Effect<void, QueryError> => {
  let byMatrix = guardCache.get(ir)
  if (!byMatrix) {
    byMatrix = new WeakMap()
    guardCache.set(ir, byMatrix)
  }
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
 * Mode-aware guard (spec §15.13, §15.17). `safe` always guards (memoized).
 * `trusted`/`unsafe` skip the guard only when a prior success is already
 * recorded for this exact shape + capability profile + emulation policy — so
 * capability checks are never bypassed without a recorded prior pass (§15.17);
 * otherwise the guard runs once (and records the result).
 *
 * @param ir - Query representation to guard.
 * @param db - Active database service (carries dialect + execution mode).
 * @returns An Effect that fails with the first violation or succeeds with void.
 */
const guardForMode = (ir: QueryIR, db: DatabaseService): Effect.Effect<void, QueryError> => {
  const matrix = db.dialect.capabilities
  if ((db.mode ?? DEFAULT_EXECUTION_MODE) === "safe") return guardCached(ir, matrix, db.allowEmulation)
  if (cachedGuardResult(ir, matrix, db.allowEmulation) === null) {
    return Effect.void
  }
  return guardCached(ir, matrix, db.allowEmulation)
}

/**
 * Decode rows honoring the active decode mode: `trusted` (from `unsafe` execution
 * mode) returns raw driver rows untouched; otherwise strict schema decoding runs.
 *
 * @param fields - Selection fields and codecs.
 * @param rows - Raw driver rows.
 * @param db - Active database service.
 * @param decoder - Optional precompiled decoder (used by prepared handles).
 * @returns An Effect yielding rows, decoded or trusted per mode.
 */
const decodeForMode = (
  fields: ReadonlyArray<SelectionField>,
  rows: ReadonlyArray<RawRow>,
  db: DatabaseService,
  decoder?: RowDecoder
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DecodeError> =>
  resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    ? Effect.succeed(rows as ReadonlyArray<Record<string, unknown>>)
    : decodeRows(fields, rows, decoder ?? rowDecoderFor(fields))

/**
 * Resolves positional bind values for a compiled query.
 *
 * @param paramOrder - Parameter nodes in compiled placeholder order.
 * @param args - Named values supplied at execution time.
 * @returns Positional values ready for the driver.
 */
const bindValues = (paramOrder: ReadonlyArray<ParamNode>, args: QueryArgs): ReadonlyArray<unknown> =>
  paramOrder.map((p) => ("value" in p ? p.value : args[p.name]))

/**
 * The prepared-statement name for a compiled query, or undefined to run it
 * unprepared. Only parameterized statements are prepared (param-free statements
 * may be multi-statement DDL, which cannot be prepared).
 *
 * @param db - Active database service and execution policy.
 * @param compiled - Compiled query metadata.
 * @returns Prepared statement name, or `undefined` for direct execution.
 */
const preparedNameFor = (db: DatabaseService, compiled: CompiledQuery): string | undefined =>
  db.preparedStatements && compiled.paramOrder.length > 0 ? compiled.cacheKey : undefined

type RowDecoder = (raw: RawRow) => Either.Either<Record<string, unknown>, ParseResult.ParseError>

/**
 * Cache of compiled row decoders keyed by the (stable, per-query) selection
 * array. Compiling the decoder is the expensive part of Effect Schema; doing it
 * once per query shape — instead of once per field per row — is the difference
 * between microseconds and milliseconds on bulk reads.
 */
const rowDecoderCache = new WeakMap<ReadonlyArray<SelectionField>, RowDecoder>()

/**
 * Precompile (and cache) the row decoder for a selection ahead of execution.
 * Prepared query handles call this at construction so the decoder plan is paid
 * once, at prepare time, not on the first read (spec §15.15).
 *
 * @param fields - Selected fields and their codecs.
 * @returns Nothing; the compiled decoder is retained in the selection cache.
 */
export const prepareDecoder = (fields: ReadonlyArray<SelectionField>): void => {
  rowDecoderFor(fields)
}

/**
 * Compiles and caches a struct decoder for a stable selection array.
 *
 * @param fields - Selected fields and their codecs.
 * @returns A synchronous decoder for raw rows.
 */
const rowDecoderFor = (fields: ReadonlyArray<SelectionField>): RowDecoder => {
  let decode = rowDecoderCache.get(fields)
  if (decode === undefined) {
    const struct: Record<string, Schema.Schema<unknown, unknown>> = {}
    for (const field of fields) struct[field.alias] = field.codec as Schema.Schema<unknown, unknown>
    decode = Schema.decodeUnknownEither(Schema.Struct(struct)) as RowDecoder
    rowDecoderCache.set(fields, decode)
  }
  return decode
}

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
  readonly compiled: CompiledQuery
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
    this.capabilityBits = this.ir.capabilities
    this.params = Object.freeze(params.map((parameter) => parameter.name))
    this.structuralFailure = collectStructuralViolations(this.ir)[0] ?? null
  }

  /**
   * Compiles this handle once for a dialect capability profile.
   *
   * @param dialect - Target SQL dialect.
   * @returns Cached or newly compiled query data.
   */
  compile(dialect: Dialect): CompiledQuery {
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
  const values = bindValues(compiled.paramOrder, args)
  const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
  return Effect.flatMap(db.driver.query(compiled.sql, values, preparedNameFor(db, compiled)), (rows) =>
    trusted ? Effect.succeed(rows as ReadonlyArray<A>) : (plan.decode(rows) as Effect.Effect<ReadonlyArray<A>, DecodeError>)
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
  const values = bindValues(compiled.paramOrder, args)
  return db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
}

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
    yield* guardForMode(ir, db)
    const compiled = compileCached(ir, db.dialect)
    const values = bindValues(compiled.paramOrder, args)
    const rows = yield* db.driver.query(compiled.sql, values, preparedNameFor(db, compiled))
    return (yield* decodeForMode(fields, rows, db)) as ReadonlyArray<A>
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
    yield* guardForMode(ir, db)
    const compiled = compileCached(ir, db.dialect)
    const values = bindValues(compiled.paramOrder, args)
    return yield* db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
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
