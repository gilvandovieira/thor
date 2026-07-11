/**
 * Named, bounded query cache layers (spec §9).
 *
 * v0 memoized on the hot path with ad-hoc module-level `WeakMap`s. v1 formalizes
 * those into the **five named cache layers** the spec calls out, each keyed by
 * query *shape* and never by parameter values (spec §9.2):
 *
 * ```txt
 * Shape       Query IR                     → normalized IR
 * Compile     Normalized IR + dialect       → compiled SQL
 * Prepared    Compiled SQL + connection     → prepared-statement identity
 * Decoder     Selection shape               → row decoder
 * Capability  Capability bits + matrix ver. → capability (guard) result
 * ```
 *
 * Every layer is a {@link CacheLayer}. The default backing is a
 * {@link WeakCacheLayer} — unbounded and GC-friendly, matching the v0 behavior
 * exactly (no retention, no eviction). Opting into {@link makeQueryCaches} with a
 * `maxSize` swaps shape caches to a {@link BoundedLruCache} that retains at most
 * `maxSize` shapes and evicts least-recently-used entries. Prepared resources have
 * an independent, finite per-connection bound. Both flavors record hit/miss (and
 * eviction) counters so cache effectiveness is observable (spec §9, §19; feeds S).
 *
 * The cache is a pure optimization: keys are query shapes (object identities and
 * value-independent strings), so a miss only ever recomputes work that was already
 * safe to recompute. Nothing here participates in guards or capability *safety* —
 * a bounded cache that evicts an entry simply recomputes the guard result.
 *
 * @module execution/cache
 */
import type { Dialect } from "../dialect.js"
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import type { QueryError } from "../errors/index.js"
import type { CompiledStatement } from "./driver.js"

/** Eviction strategy for a bounded cache layer. Only `"lru"` is defined in v1. */
export type CacheStrategy = "lru"

/** Options for {@link makeQueryCaches} / `withQueryCache` (spec §9.3). */
export interface QueryCacheOptions {
  /**
   * Maximum number of distinct query shapes retained per layer. When set, layers
   * become bounded LRU caches; when omitted, layers are unbounded and
   * GC-friendly (the default, matching v0).
   */
  readonly maxSize?: number
  /**
   * Maximum prepared shapes admitted per physical connection. Defaults to `100`,
   * independently of `maxSize`, so server/client prepared registries stay bounded.
   */
  readonly preparedMaxSize?: number
  /** Eviction strategy for bounded layers. Defaults to `"lru"`. */
  readonly strategy?: CacheStrategy
}

/** Conservative default bound for prepared resources on each physical connection. */
const DEFAULT_PREPARED_MAX_SIZE = 100

/** Point-in-time counters for a single cache layer. */
export interface CacheLayerStats {
  /** Layer name (`shape`, `compile`, `prepared`, `decoder`, `capability`). */
  readonly name: string
  /** Lookups that returned a cached value. */
  readonly hits: number
  /** Lookups that had to compute a value. */
  readonly misses: number
  /** Entries dropped by the eviction policy (always `0` for unbounded layers). */
  readonly evictions: number
  /** Current number of retained entries (`undefined` for weak, uncountable layers). */
  readonly size: number | undefined
  /** Configured bound, or `undefined` when unbounded. */
  readonly maxSize: number | undefined
  /** Native prepared resources admitted (prepared layer only). */
  readonly admissions?: number
  /** Shapes deliberately run unprepared because admission was unsafe or full. */
  readonly admissionBypasses?: number
  /** Successful physical finalize/unprepare operations. */
  readonly physicalReleases?: number
  /** Failed physical finalize/unprepare operations. */
  readonly releaseFailures?: number
}

/**
 * A single cache layer keyed by an object *shape*. Both implementations record
 * hit/miss counters; bounded layers additionally record evictions.
 *
 * @typeParam K - Shape key (an object identity — IR node, dialect, selection).
 * @typeParam V - Cached value.
 */
export interface CacheLayer<K extends object, V> {
  /** Human-readable layer name, used in {@link CacheLayerStats}. */
  readonly name: string
  /**
   * Return the value cached for `key`, computing and storing it on a miss.
   *
   * @param key - Shape key.
   * @param compute - Thunk run only on a miss.
   * @returns The cached or freshly computed value.
   */
  getOrCompute(key: K, compute: () => V): V
  /**
   * Read a cached value without recording a miss or computing one.
   *
   * @param key - Shape key.
   * @returns The cached value, or `undefined` when absent.
   */
  peek(key: K): V | undefined
  /** @returns A snapshot of this layer's counters. */
  stats(): CacheLayerStats
  /**
   * Clear all entries and reset counters.
   *
   * @returns Nothing.
   */
  reset(): void
}

/**
 * Unbounded, GC-friendly cache layer backed by a `WeakMap`. Entries are retained
 * only as long as their shape key is reachable elsewhere, so this never leaks and
 * needs no eviction. `size` is unobservable for a `WeakMap` and reported as
 * `undefined`.
 *
 * @typeParam K - Shape key.
 * @typeParam V - Cached value.
 */
export class WeakCacheLayer<K extends object, V> implements CacheLayer<K, V> {
  private store = new WeakMap<K, V>()
  private hits = 0
  private misses = 0

  /**
   * @param name - Layer name for diagnostics.
   */
  constructor(readonly name: string) {}

  /**
   * Return the value cached for `key`, computing and storing it on a miss.
   *
   * @param key - Shape key.
   * @param compute - Thunk run only on a miss.
   * @returns The cached or freshly computed value.
   */
  getOrCompute(key: K, compute: () => V): V {
    const existing = this.store.get(key)
    if (existing !== undefined) {
      this.hits++
      return existing
    }
    this.misses++
    const value = compute()
    this.store.set(key, value)
    return value
  }

  /**
   * Read a cached value without recording a miss or computing one.
   *
   * @param key - Shape key.
   * @returns The cached value, or `undefined` when absent.
   */
  peek(key: K): V | undefined {
    return this.store.get(key)
  }

  /** @returns A snapshot of this layer's counters (size is unobservable for a WeakMap). */
  stats(): CacheLayerStats {
    return { name: this.name, hits: this.hits, misses: this.misses, evictions: 0, size: undefined, maxSize: undefined }
  }

  /**
   * Drop all entries and reset counters.
   *
   * @returns Nothing.
   */
  reset(): void {
    // A WeakMap cannot be iterated/cleared; drop the reference instead.
    this.store = new WeakMap<K, V>()
    this.hits = 0
    this.misses = 0
  }
}

/**
 * Bounded cache layer with least-recently-used eviction, backed by an insertion-
 * ordered `Map`. Reads and writes move the entry to the most-recently-used end;
 * once `maxSize` is exceeded the least-recently-used entry is evicted. Unlike
 * {@link WeakCacheLayer} this retains keys strongly, which is the point — it caps
 * memory at `maxSize` shapes.
 *
 * @typeParam K - Shape key.
 * @typeParam V - Cached value.
 */
export class BoundedLruCache<K extends object, V> implements CacheLayer<K, V> {
  private readonly store = new Map<K, V>()
  private hits = 0
  private misses = 0
  private evictions = 0

  /**
   * @param name - Layer name for diagnostics.
   * @param maxSize - Maximum retained entries; must be a positive integer.
   * @throws {RangeError} When `maxSize` is not a positive integer.
   */
  constructor(
    readonly name: string,
    private readonly maxSize: number
  ) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(`Query cache maxSize must be a positive integer, received ${maxSize}`)
    }
  }

  /**
   * Return the value cached for `key`, computing and storing it on a miss, and
   * refresh the key to most-recently-used.
   *
   * @param key - Shape key.
   * @param compute - Thunk run only on a miss.
   * @returns The cached or freshly computed value.
   */
  getOrCompute(key: K, compute: () => V): V {
    const existing = this.store.get(key)
    if (existing !== undefined) {
      this.hits++
      // Refresh recency: delete + re-insert moves the key to the MRU end.
      this.store.delete(key)
      this.store.set(key, existing)
      return existing
    }
    this.misses++
    const value = compute()
    this.store.set(key, value)
    this.evict()
    return value
  }

  /**
   * Read a cached value without recording a miss, computing, or changing recency.
   *
   * @param key - Shape key.
   * @returns The cached value, or `undefined` when absent.
   */
  peek(key: K): V | undefined {
    return this.store.get(key)
  }

  /** @returns A snapshot of this layer's counters. */
  stats(): CacheLayerStats {
    return {
      name: this.name,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.store.size,
      maxSize: this.maxSize
    }
  }

  /**
   * Drop all entries and reset counters.
   *
   * @returns Nothing.
   */
  reset(): void {
    this.store.clear()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /**
   * Drop least-recently-used entries until the bound is honored.
   *
   * @returns Nothing.
   */
  private evict(): void {
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value as K | undefined
      if (oldest === undefined) break
      this.store.delete(oldest)
      this.evictions++
    }
  }
}

/**
 * Build one cache layer honoring the requested options: a {@link BoundedLruCache}
 * when `maxSize` is set, otherwise an unbounded {@link WeakCacheLayer}.
 *
 * @typeParam K - Shape key.
 * @typeParam V - Cached value.
 * @param name - Layer name.
 * @param options - Cache options (see {@link QueryCacheOptions}).
 * @returns A cache layer.
 */
const makeLayer = <K extends object, V>(name: string, options: QueryCacheOptions): CacheLayer<K, V> =>
  options.maxSize === undefined ? new WeakCacheLayer<K, V>(name) : new BoundedLruCache<K, V>(name, options.maxSize)

/** Per-dialect compilation cache for one query shape. */
type CompileByDialect = Map<Dialect, CompiledStatement>
/** Per-policy capability (guard) result cache for one shape + matrix. */
type GuardByPolicy = Map<boolean, QueryError | null>
/** Per-matrix guard caches for one query shape. */
type GuardByMatrix = Map<CapabilityMatrix, GuardByPolicy>

/** A stable selection array used as the decoder cache key. */
export type SelectionKey = ReadonlyArray<unknown>
/** A stable row decoder produced for a selection shape. */
export type DecoderValue = unknown

/**
 * The five named query cache layers (spec §9.1), bundled per configuration.
 *
 * The **shape**, **compile**, **decoder** and **capability** layers back the
 * non-prepared execution path in `run.ts`. The **prepared** layer observes which
 * compiled shapes are eligible for server-side prepared-statement reuse (the
 * statement itself lives in the driver/connection, keyed by `cacheKey`). Prepared
 * query handles (Epic D) keep their own per-handle caches and do not consult this
 * registry.
 *
 * Construct with {@link makeQueryCaches}; the process-wide default is
 * {@link defaultQueryCaches}.
 *
 * @internal Cache representation is not a compatibility surface.
 */
export class QueryCaches {
  /** Shape layer: raw IR identity → normalized IR. */
  readonly shape: CacheLayer<object, unknown>
  /** Compile layer: normalized IR identity → per-dialect compiled SQL. */
  readonly compile: CacheLayer<object, CompileByDialect>
  /** Decoder layer: selection shape → compiled row decoder. */
  readonly decoder: CacheLayer<SelectionKey & object, DecoderValue>
  /** Capability layer: IR identity → per-matrix, per-policy guard result. */
  readonly capability: CacheLayer<object, GuardByMatrix>
  /**
   * Prepared layer: value-independent compiled-shape keys already registered for
   * server-side prepared-statement reuse. The statement itself lives in the
   * driver/connection; this layer observes reuse.
   */
  private preparedHits = 0
  private preparedMisses = 0
  private preparedEvictions = 0
  private preparedSize = 0
  private preparedAdmissions = 0
  private preparedAdmissionBypasses = 0
  private preparedPhysicalReleases = 0
  private preparedReleaseFailures = 0

  /** Configured bound for each physical connection's prepared registry. */
  readonly preparedMaxSize: number

  /**
   * @param options - Independent shape-cache and prepared-resource options.
   */
  constructor(options: QueryCacheOptions = {}) {
    this.shape = makeLayer("shape", options)
    this.compile = makeLayer("compile", options)
    this.decoder = makeLayer("decoder", options)
    this.capability = makeLayer("capability", options)
    const preparedMaxSize = options.preparedMaxSize ?? DEFAULT_PREPARED_MAX_SIZE
    if (!Number.isInteger(preparedMaxSize) || preparedMaxSize <= 0) {
      throw new RangeError(`Query cache preparedMaxSize must be a positive integer, received ${preparedMaxSize}`)
    }
    this.preparedMaxSize = preparedMaxSize
  }

  /**
   * Record the result of one connection-scoped prepared-registry lookup.
   *
   * @param outcome - Whether the physical connection registry hit or missed.
   * @param size - Current physical connection registry size.
   * @param evictions - Number of actual prepared resources evicted.
   * @returns Nothing.
   */
  notePrepared(outcome: "hit" | "miss", size: number, evictions: number): void {
    if (outcome === "hit") this.preparedHits++
    else this.preparedMisses++
    this.preparedEvictions += evictions
    this.preparedSize = size
  }

  /**
   * Records a physical prepared-resource lifecycle transition.
   *
   * @param event - Admission, capacity bypass, release, or release failure.
   * @param size - Actual native-admitted registry size.
   * @returns Nothing.
   * @internal
   */
  notePreparedLifecycle(
    event: "admission" | "admission-bypass" | "physical-release" | "release-failure",
    size: number
  ): void {
    if (event === "admission") this.preparedAdmissions++
    else if (event === "admission-bypass") this.preparedAdmissionBypasses++
    else if (event === "physical-release") this.preparedPhysicalReleases++
    else this.preparedReleaseFailures++
    this.preparedSize = size
  }

  /** @returns A snapshot of every layer's counters (spec §9, §19). */
  stats(): ReadonlyArray<CacheLayerStats> {
    return [
      this.shape.stats(),
      this.compile.stats(),
      {
        name: "prepared",
        hits: this.preparedHits,
        misses: this.preparedMisses,
        evictions: this.preparedEvictions,
        size: this.preparedSize,
        maxSize: this.preparedMaxSize,
        admissions: this.preparedAdmissions,
        admissionBypasses: this.preparedAdmissionBypasses,
        physicalReleases: this.preparedPhysicalReleases,
        releaseFailures: this.preparedReleaseFailures
      },
      this.decoder.stats(),
      this.capability.stats()
    ]
  }

  /**
   * Clear every layer and reset all counters.
   *
   * @returns Nothing.
   */
  reset(): void {
    this.shape.reset()
    this.compile.reset()
    this.decoder.reset()
    this.capability.reset()
    this.preparedHits = 0
    this.preparedMisses = 0
    this.preparedEvictions = 0
    this.preparedSize = 0
    this.preparedAdmissions = 0
    this.preparedAdmissionBypasses = 0
    this.preparedPhysicalReleases = 0
    this.preparedReleaseFailures = 0
  }
}

/**
 * Build a {@link QueryCaches} registry from cache options (spec §9.3). Omitting
 * `maxSize` yields unbounded, GC-friendly shape layers identical to v0; supplying
 * it yields bounded LRU shape layers. Prepared resources always use the separate
 * finite `preparedMaxSize` bound.
 *
 * @param options - Cache options.
 * @returns A configured cache registry.
 */
export const makeQueryCaches = (options: QueryCacheOptions = {}): QueryCaches => new QueryCaches(options)

/**
 * Process-wide default cache registry used when a `Database` layer does not
 * install its own via `withQueryCache`. Shape layers are unbounded and
 * GC-friendly; prepared resources retain at most 100 shapes per connection.
 */
export const defaultQueryCaches: QueryCaches = new QueryCaches()
