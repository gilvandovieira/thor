/**
 * The precompiled per-handle execution plan (spec §15.13, §15.15).
 *
 * A {@link PreparedExecutionPlan} performs all dialect-independent work once at
 * construction (snapshot, normalize, structural guard, decoder plan, parameter
 * plan) and memoizes dialect-specific compile/guard results keyed by dialect
 * object, capability profile, and emulation policy. It builds on the shared
 * pipeline primitives in {@link module:execution/run-pipeline}.
 *
 * @module execution/prepared-plan
 */
import type { Effect } from "effect"
import {
  collectQueryParams,
  queryCapabilityBits,
  type ParamNode,
  type QueryIR,
  type SelectionField
} from "../ir/query-ir.js"
import { collectCapabilityViolations, collectStructuralViolations } from "../guards/query-guards.js"
import type { Dialect } from "../dialect.js"
import type { CapabilityBits } from "../capabilities/capability.js"
import { queryStructuralHash } from "../ir/structural-hash.js"
import { normalizeQuery } from "../ir/normalize.js"
import { type DecodeError, GuardError, type ParameterError, type QueryError } from "../errors/index.js"
import type { CompiledStatement, RawRow } from "./driver.js"
import { decodeRows, ParameterPlan, type QueryArgs, type RowDecoder, rowDecoderFor } from "./run-pipeline.js"

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
   * @param dialect - Target dialect.
   * @returns Whether this plan already retains SQL for the dialect's current profile.
   * @internal
   */
  hasCompilation(dialect: Dialect): boolean {
    return this.compilations.get(dialect)?.profileHash === dialect.profileHash
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

    const failure =
      this.structuralFailure ?? collectCapabilityViolations(this.ir, dialect.capabilities, allowEmulation)[0] ?? null
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
