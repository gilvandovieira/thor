/**
 * Execution/decode modes and the plan-level cache key (spec §15.13, §15.14).
 *
 * The compiled `cacheKey` (from the SQL compiler) identifies a *compiled SQL
 * shape* — dialect id + capability profile + structural hash — and is what a
 * server-side prepared statement is named by. It is deliberately mode-independent
 * so the same SQL is prepared once and reused across execution modes.
 *
 * Execution mode and decode mode change *what runtime work Thor does around* that
 * SQL (guarding, decode strictness), not the SQL text. They therefore compose at
 * this plan layer: `planKey` is the identity of a precompiled execution plan
 * (Epic D handles) — compiled cache key + mode + decode mode — completing the
 * §15.14 composition without fragmenting prepared statements.
 *
 * @module execution/plan
 */
import { Effect, Layer } from "effect"
import type { CompiledStatement } from "./driver.js"
import { Database, type DatabaseService } from "./database.js"
import { makeQueryCaches, type QueryCacheOptions } from "./cache.js"

/**
 * Runtime safety/performance mode (spec §10, §15.13). All three modes are wired:
 * `safe` (default) always guards and decodes; `trusted` skips re-guarding
 * shapes with a recorded prior pass; `unsafe-hot` additionally skips decode. The
 * non-default modes are opt-in only via {@link withMode}.
 *
 * `"unsafe"` is a **deprecated v0 alias** for `"unsafe-hot"` (spec §10.3); it is
 * normalized away by {@link normalizeMode}. New code should use `"unsafe-hot"`.
 */
export type ExecutionMode = "safe" | "trusted" | "unsafe-hot" | "unsafe"

/** Execution modes without the deprecated `"unsafe"` alias (spec §10). */
export type CanonicalExecutionMode = "safe" | "trusted" | "unsafe-hot"

/**
 * Normalize the deprecated `"unsafe"` alias to `"unsafe-hot"` (spec §10.3).
 *
 * @param mode - Requested execution mode.
 * @returns The canonical execution mode.
 */
export const normalizeMode = (mode: ExecutionMode): CanonicalExecutionMode =>
  mode === "unsafe" ? "unsafe-hot" : mode

/** How strictly decoded rows are validated. */
export type DecodeMode = "strict" | "trusted"

/** Default execution policy, preserving all guards and validations. */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "safe"
/** Default row-decoding policy, preserving schema validation. */
export const DEFAULT_DECODE_MODE: DecodeMode = "strict"

/**
 * The full plan cache key (spec §15.14): compiled SQL-shape key + execution mode
 * + decode mode. Never includes parameter values.
 *
 * @param compiled - Compiled query whose `cacheKey` carries dialect+profile+structural identity.
 * @param mode - Selected execution mode (default `safe`).
 * @param decodeMode - Selected decode mode (default `strict`).
 * @returns A stable, value-independent plan identity.
 */
export const planKey = (
  compiled: CompiledStatement,
  mode: ExecutionMode = DEFAULT_EXECUTION_MODE,
  decodeMode: DecodeMode = DEFAULT_DECODE_MODE
): string => `${compiled.cacheKey}:${mode}:${decodeMode}`

/**
 * The decode mode implied by an execution mode: `unsafe-hot` (and its deprecated
 * `unsafe` alias) trusts driver rows (skips schema decoding); every other mode
 * decodes strictly. An explicit `decodeMode` always wins.
 *
 * @param mode - Selected execution mode.
 * @param decodeMode - Optional explicit decode override.
 * @returns The effective decode mode.
 */
export const resolveDecodeMode = (mode: ExecutionMode, decodeMode?: DecodeMode): DecodeMode =>
  decodeMode ?? (normalizeMode(mode) === "unsafe-hot" ? "trusted" : "strict")

/**
 * Wrap a `Database` layer to run in a different execution mode (spec §10, §15.13).
 *
 * This is the opt-in for `trusted`/`unsafe-hot` — it never changes the query API
 * shape, only how much runtime work Thor does around the same compiled SQL.
 * `unsafe-hot` is a deliberate, explicit choice (skips row decoding), so it must
 * be requested through this wrapper; it is never a default. The deprecated
 * `unsafe` alias is normalized to `unsafe-hot`.
 *
 * ```ts
 * const HotPath = withMode(PostgresLayer(client), "trusted")
 * const Untyped = withMode(PostgresLayer(client), "unsafe-hot") // skips decode — opt-in
 * ```
 *
 * @param layer - Base layer providing `Database`.
 * @param mode - Execution mode to apply.
 * @param decodeMode - Optional explicit decode override (defaults to `mode`'s implied mode).
 * @returns A layer providing `Database` with the mode applied.
 */
export const withMode = (
  layer: Layer.Layer<Database>,
  mode: ExecutionMode,
  decodeMode?: DecodeMode
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.map(Database, (db): DatabaseService => ({
      ...db,
      mode: normalizeMode(mode),
      decodeMode: resolveDecodeMode(mode, decodeMode)
    }))
  ).pipe(Layer.provide(layer))

/**
 * Wrap a `Database` layer to install a named, bounded query cache (spec §9.3).
 *
 * By default a service uses the process-wide, unbounded {@link defaultQueryCaches}.
 * This wrapper installs a dedicated {@link QueryCaches} registry — bounded LRU
 * when `maxSize` is set — so the non-prepared execution path memoizes shape,
 * compile, decoder and capability work within a retained budget and exposes
 * hit/miss/eviction counters via `db.queryCache.stats()`.
 *
 * ```ts
 * const Bounded = withQueryCache(PostgresLayer(client), { maxSize: 10_000, strategy: "lru" })
 * ```
 *
 * @param layer - Base layer providing `Database`.
 * @param options - Cache options; omit `maxSize` for an unbounded dedicated registry.
 * @returns A layer providing `Database` with the cache installed.
 */
export const withQueryCache = (
  layer: Layer.Layer<Database>,
  options: QueryCacheOptions = {}
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.map(Database, (db): DatabaseService => ({ ...db, queryCache: makeQueryCaches(options) }))
  ).pipe(Layer.provide(layer))
