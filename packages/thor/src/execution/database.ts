/**
 * The `Database` service (spec §5, Milestone 5).
 *
 * Execution methods on queries require this service from the Effect context.
 * It bundles the dialect (compiler + capability matrix) with a `Driver` and the
 * emulation policy. Layers in ../testing and (later) ../postgres provide it.
 *
 * @module execution/database
 */
import { Context } from "effect"
import type { Dialect } from "../dialect.js"
import type { Driver } from "./driver.js"
import type { DecodeMode, ExecutionMode } from "./plan.js"
import type { QueryCaches } from "./cache.js"
import type { ObservabilityConfig, ObservabilityContext } from "../observability/index.js"

/** Services required by query execution. */
export interface DatabaseService {
  /** Active backend dialect used for guards and compilation. */
  readonly dialect: Dialect
  /** Transport adapter used to execute compiled statements. */
  readonly driver: Driver
  /** Whether `emulated` capabilities may satisfy guards (spec §4.4). */
  readonly allowEmulation: boolean
  /**
   * Whether parameterized executions should reuse server-side prepared
   * statements keyed by the compiled `cacheKey` (spec §16). Defaults to `true`
   * on the live layers. Param-free statements are never prepared.
   */
  readonly preparedStatements: boolean
  /**
   * Execution mode (spec §15.13). Absent → `"safe"` (full guards + strict
   * decode). `"trusted"` skips re-guarding shapes already validated for this
   * dialect profile; `"unsafe"` additionally skips row decoding. Set it with
   * `withMode(layer, mode)` — `"unsafe"` is opt-in only and never a default.
   */
  readonly mode?: ExecutionMode
  /** Row-decode strictness (spec §15.13). Absent → derived from `mode`. */
  readonly decodeMode?: DecodeMode
  /**
   * Named query cache registry backing the non-prepared execution path (spec
   * §9.1). Absent → the process-wide {@link defaultQueryCaches} (unbounded,
   * GC-friendly). Install a bounded LRU registry with `withQueryCache`.
   */
  readonly queryCache?: QueryCaches
  /** Opt-in tracing, metrics, and safe logging configuration (spec §17). */
  readonly observability?: ObservabilityConfig
  /** Transaction and migration context propagated into query metadata. */
  readonly observabilityContext?: ObservabilityContext
  /** Whether execution should update prepared-cache observation counters. @internal */
  readonly recordPreparedCache?: boolean
}

/** Effect context tag that provides the active `DatabaseService`. */
export class Database extends Context.Tag("thor/Database")<Database, DatabaseService>() {}
