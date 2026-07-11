/**
 * Low-level driver contract and compiled-query shape (spec §16).
 *
 * A `Driver` is the thin seam between Thor and a real database client (or the
 * fake driver used in tests). Thor compiles IR to a `CompiledStatement`, binds
 * values separately, and hands both to the driver.
 *
 * @module execution/driver
 */
import type { Effect } from "effect"
import type { ParamNode } from "../ir/query-ir.js"
import type { ConstraintError, DriverError } from "../errors/index.js"
import type { RuntimeRequirements } from "../capabilities/runtime.js"

/** A raw, undecoded database row. */
export type RawRow = Record<string, unknown>

/** Result of a non-select command. */
export interface CommandResult {
  /** Number of rows affected by the command. */
  readonly rowCount: number
}

/** A query shape lowered to dialect SQL with its parameters separated (spec §16). */
export interface CompiledStatement {
  /** Dialect-specific SQL text. */
  readonly sql: string
  /** Parameters in positional bind order. */
  readonly paramOrder: ReadonlyArray<ParamNode>
  /** Stable structural cache key (independent of bound values). */
  readonly cacheKey: string
}

/**
 * The seam to a real client. Implementations map native failures to
 * `DriverError` / `ConstraintError`; everything above this layer is dialect- and
 * client-agnostic.
 *
 * `preparedName` is the stable, value-independent identity of the query shape
 * (the compiler's `cacheKey`). When present, adapters may register/reuse a
 * server-side prepared statement so identical shapes skip re-parsing (spec §16).
 * When absent, adapters run the statement without preparing it (used for
 * param-free, possibly multi-statement DDL).
 *
 * @stable
 */
export interface Driver {
  /** Runtime capabilities required by this adapter implementation. */
  readonly runtime: RuntimeRequirements

  /**
   * Runs a statement expected to return rows.
   *
   * @param sql - Dialect-compiled SQL text.
   * @param params - Positional values in placeholder order.
   * @param preparedName - Optional stable identity for prepared-statement reuse.
   * @param maxRows - Optional upper bound for a cardinality probe.
   * @returns An Effect yielding raw, undecoded rows.
   */
  readonly query: (
    sql: string,
    params: ReadonlyArray<unknown>,
    preparedName?: string,
    maxRows?: number
  ) => Effect.Effect<ReadonlyArray<RawRow>, DriverError | ConstraintError>

  /**
   * Runs a statement expected to return an affected-row count.
   *
   * @param sql - Dialect-compiled SQL text.
   * @param params - Positional values in placeholder order.
   * @param preparedName - Optional stable identity for prepared-statement reuse.
   * @returns An Effect yielding the normalized command result.
   */
  readonly execute: (
    sql: string,
    params: ReadonlyArray<unknown>,
    preparedName?: string
  ) => Effect.Effect<CommandResult, DriverError | ConstraintError>

  /**
   * Runs a parameter-free SQL script that may contain multiple statements.
   *
   * @param sql - Trusted script text, typically emitted by the migrator.
   * @returns An Effect yielding the normalized command result.
   */
  readonly executeScript?: (sql: string) => Effect.Effect<CommandResult, DriverError | ConstraintError>

  /**
   * Releases one connection-scoped prepared resource after cache eviction.
   * Adapters omit this when their public client contract cannot safely release
   * and later recreate a named statement; bounded execution then stops admitting
   * new prepared shapes rather than leaking resources.
   *
   * @param preparedName - Stable prepared identity previously passed to query/execute.
   * @returns An Effect completing resource release.
   */
  readonly releasePrepared?: (preparedName: string) => Effect.Effect<void, DriverError | ConstraintError>

  /** @returns An Effect releasing every prepared resource owned by this physical connection. */
  readonly clearPrepared?: () => Effect.Effect<void, DriverError | ConstraintError>

  /**
   * Identity of the physical connection that owns server-side prepared
   * statements. The execution pipeline keys its prepared-name registry by this
   * object so registries survive driver re-creation over the same pooled
   * connection (a fresh per-driver registry would forget names the connection
   * still holds, admitting silent name collisions). Defaults to the driver
   * instance when omitted.
   */
  readonly preparedScope?: object
}
