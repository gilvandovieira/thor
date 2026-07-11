/**
 * The runtime execution pipeline (spec §7.5):
 *   guard → capability check → compile → bind → execute → decode → cardinality.
 *
 * This module orchestrates a full execution by composing the pipeline primitives
 * from {@link module:execution/run-pipeline} and the precompiled handle from
 * {@link module:execution/prepared-plan}, and refines row collections by
 * cardinality. It re-exports the handle and `QueryArgs` so `./run.js` stays the
 * stable import surface.
 *
 * @module execution/run
 */
import { Effect, Option } from "effect"
import type { QueryIR, SelectionField } from "../ir/query-ir.js"
import { NotFoundError, type QueryError, TooManyRowsError } from "../errors/index.js"
import type { CommandResult, CompiledStatement } from "./driver.js"
import type { DatabaseService } from "./database.js"
import { DEFAULT_EXECUTION_MODE, resolveDecodeMode } from "./plan.js"
import { observeQuery } from "../observability/index.js"
import {
  bindValues,
  cachesFor,
  compileVia,
  decodeForMode,
  guardForMode,
  hasCompiled,
  observationState,
  prepareForExecution,
  type QueryArgs,
  shapeVia
} from "./run-pipeline.js"
import { PreparedExecutionPlan } from "./prepared-plan.js"
import type { QueryObservationState } from "../observability/index.js"

/**
 * Wraps a row-producing effect and a cardinality refinement in a **single**
 * observed span, so `NotFoundError`/`TooManyRowsError` are captured as the
 * query's `errorTag` rather than reported as a successful event (Finding 14).
 * The observed row count is the number of rows actually read and decoded (not
 * the refined count), across the direct, compiled, and prepared paths.
 *
 * @typeParam A - Decoded row shape.
 * @typeParam B - Refined result (rows, a single row, or an Option).
 * @typeParam E2 - Refinement error channel.
 * @param db - Active database service.
 * @param ir - Query representation for span metadata.
 * @param args - Named arguments (for parameter logging).
 * @param state - Mutable observation state populated during execution.
 * @param rows - The row-producing execution effect.
 * @param refine - Cardinality refinement applied inside the observed span.
 * @returns The refined result, observed with an accurate row count and error tag.
 */
const observeRefined = <A, B, E2>(
  db: DatabaseService,
  ir: QueryIR,
  args: QueryArgs,
  state: QueryObservationState,
  rows: Effect.Effect<ReadonlyArray<A>, QueryError>,
  refine: (rows: ReadonlyArray<A>) => Effect.Effect<B, E2>
): Effect.Effect<B, QueryError | E2> => {
  let read: number | undefined
  const combined = Effect.flatMap(rows, (decoded) => {
    read = decoded.length
    return refine(decoded)
  })
  return observeQuery(
    db,
    ir,
    args,
    state,
    combined,
    () => read,
    () => read
  )
}

/**
 * Identity refinement for `.all()`.
 *
 * @typeParam A - Decoded row shape.
 * @param rows - Decoded rows.
 * @returns An Effect yielding every decoded row.
 */
const allRows = <A>(rows: ReadonlyArray<A>): Effect.Effect<ReadonlyArray<A>, never> => Effect.succeed(rows)

/**
 * Executes a prepared row-returning plan with per-call values.
 *
 * @typeParam A - Decoded row shape.
 * @param plan - Precomputed execution plan.
 * @param db - Active database service.
 * @param args - Named parameter values for this call only.
 * @param state - Mutable observation state populated during execution.
 * @returns An Effect yielding decoded rows.
 */
const preparedRowsExecution = <A>(
  plan: PreparedExecutionPlan,
  db: DatabaseService,
  args: QueryArgs,
  state: QueryObservationState
): Effect.Effect<ReadonlyArray<A>, QueryError> =>
  Effect.gen(function* () {
    const failure = plan.guard(db.dialect, db.allowEmulation)
    if (failure) return yield* Effect.fail(failure)
    state.compileCache = plan.hasCompilation(db.dialect) ? "hit" : "miss"
    const compiled = plan.compile(db.dialect)
    state.compiledSql = compiled.sql
    state.paramOrder = compiled.paramOrder
    const values = yield* plan.bind(compiled.paramOrder, args)
    state.values = values
    const prepared = yield* prepareForExecution(db, cachesFor(db), compiled)
    state.preparedCache = prepared.outcome
    const rows = yield* db.driver.query(compiled.sql, values, prepared.name)
    const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    return trusted ? (rows as ReadonlyArray<A>) : ((yield* plan.decode(rows)) as ReadonlyArray<A>)
  })

/**
 * Executes a prepared plan and yields every decoded row (`.all()`), observed.
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
): Effect.Effect<ReadonlyArray<A>, QueryError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, preparedRowsExecution<A>(plan, db, args, state), allRows)
  })

/**
 * Prepared `.one()`: exactly one row, with the cardinality error observed.
 *
 * @param plan - Precomputed execution plan. @param db - Active database service.
 * @param args - Per-call named values. @param operation - Diagnostic operation name.
 * @returns The single decoded row.
 */
export const executePreparedOne = <A>(
  plan: PreparedExecutionPlan,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<A, QueryError | NotFoundError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, preparedRowsExecution<A>(plan, db, args, state), (rows) =>
      exactlyOne(rows, operation)
    )
  })

/**
 * Prepared `.maybeOne()`: zero or one row, with the cardinality error observed.
 *
 * @param plan - Precomputed execution plan. @param db - Active database service.
 * @param args - Per-call named values. @param operation - Diagnostic operation name.
 * @returns `Option.none()` or `Option.some(row)`.
 */
export const executePreparedMaybeOne = <A>(
  plan: PreparedExecutionPlan,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<Option.Option<A>, QueryError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, preparedRowsExecution<A>(plan, db, args, state), (rows) =>
      atMostOne(rows, operation)
    )
  })

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
): Effect.Effect<CommandResult, QueryError> =>
  Effect.suspend(() => {
    const state = observationState()
    const execution = Effect.gen(function* () {
      const failure = plan.guard(db.dialect, db.allowEmulation)
      if (failure) return yield* Effect.fail(failure)
      state.compileCache = plan.hasCompilation(db.dialect) ? "hit" : "miss"
      const compiled = plan.compile(db.dialect)
      state.compiledSql = compiled.sql
      state.paramOrder = compiled.paramOrder
      const values = yield* plan.bind(compiled.paramOrder, args)
      state.values = values
      const prepared = yield* prepareForExecution(db, cachesFor(db), compiled)
      state.preparedCache = prepared.outcome
      return yield* db.driver.execute(compiled.sql, values, prepared.name)
    })
    return observeQuery(db, plan.ir, args, state, execution, (result) => result.rowCount)
  })

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
 * @param state - Mutable observation state populated during execution.
 * @returns An Effect yielding decoded rows.
 */
const compiledRowsExecution = <A>(
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs,
  state: QueryObservationState
): Effect.Effect<ReadonlyArray<A>, QueryError> => {
  state.compileCache = "hit"
  state.compiledSql = compiled.sql
  state.paramOrder = compiled.paramOrder
  return Effect.gen(function* () {
    const values = yield* plan.bind(compiled.paramOrder, args)
    state.values = values
    const prepared = yield* prepareForExecution(db, cachesFor(db), compiled)
    state.preparedCache = prepared.outcome
    const rows = yield* db.driver.query(compiled.sql, values, prepared.name)
    const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    return trusted ? (rows as ReadonlyArray<A>) : ((yield* plan.decode(rows)) as ReadonlyArray<A>)
  })
}

/**
 * Executes an already-compiled plan and yields every decoded row (`.all()`),
 * observed.
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
): Effect.Effect<ReadonlyArray<A>, QueryError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, compiledRowsExecution<A>(plan, compiled, db, args, state), allRows)
  })

/**
 * Compiled `.one()`: exactly one row, with the cardinality error observed.
 *
 * @param plan - Precomputed plan. @param compiled - Compiled SQL. @param db - Service.
 * @param args - Per-call values. @param operation - Diagnostic operation name.
 * @returns The single decoded row.
 */
export const executeCompiledOne = <A>(
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<A, QueryError | NotFoundError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, compiledRowsExecution<A>(plan, compiled, db, args, state), (rows) =>
      exactlyOne(rows, operation)
    )
  })

/**
 * Compiled `.maybeOne()`: zero or one row, with the cardinality error observed.
 *
 * @param plan - Precomputed plan. @param compiled - Compiled SQL. @param db - Service.
 * @param args - Per-call values. @param operation - Diagnostic operation name.
 * @returns `Option.none()` or `Option.some(row)`.
 */
export const executeCompiledMaybeOne = <A>(
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<Option.Option<A>, QueryError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, plan.ir, args, state, compiledRowsExecution<A>(plan, compiled, db, args, state), (rows) =>
      atMostOne(rows, operation)
    )
  })

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
  Effect.suspend(() => {
    const state = observationState()
    state.compileCache = "hit"
    state.compiledSql = compiled.sql
    state.paramOrder = compiled.paramOrder
    const execution = Effect.gen(function* () {
      const values = yield* plan.bind(compiled.paramOrder, args)
      state.values = values
      const prepared = yield* prepareForExecution(db, cachesFor(db), compiled)
      state.preparedCache = prepared.outcome
      return yield* db.driver.execute(compiled.sql, values, prepared.name)
    })
    return observeQuery(db, plan.ir, args, state, execution, (result) => result.rowCount)
  })

/**
 * Guards, compiles, binds, executes, and decodes a row-returning query (the
 * unobserved core shared by `.all()`/`.one()`/`.maybeOne()`).
 *
 * @typeParam A - Decoded row shape.
 * @param ir - Immutable runtime query representation.
 * @param fields - Selection fields and codecs used to decode each row.
 * @param db - Active database service.
 * @param args - Named parameter values.
 * @param state - Mutable observation state populated during execution.
 * @returns An Effect yielding decoded rows or a typed query error.
 */
const directRowsExecution = <A>(
  ir: QueryIR,
  fields: ReadonlyArray<SelectionField>,
  db: DatabaseService,
  args: QueryArgs,
  state: QueryObservationState
): Effect.Effect<ReadonlyArray<A>, QueryError> =>
  Effect.gen(function* () {
    const caches = cachesFor(db)
    const shape = shapeVia(caches, ir)
    yield* guardForMode(caches, shape, db)
    state.compileCache = hasCompiled(caches, shape, db.dialect) ? "hit" : "miss"
    const compiled = compileVia(caches, shape, db.dialect)
    state.compiledSql = compiled.sql
    state.paramOrder = compiled.paramOrder
    const values = yield* bindValues(shape, compiled.paramOrder, args)
    state.values = values
    const prepared = yield* prepareForExecution(db, caches, compiled)
    state.preparedCache = prepared.outcome
    const rows = yield* db.driver.query(compiled.sql, values, prepared.name)
    return (yield* decodeForMode(caches, fields, rows, db)) as ReadonlyArray<A>
  })

/**
 * Executes a row-returning query and yields every decoded row (`.all()`),
 * within an observed span.
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
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, ir, args, state, directRowsExecution<A>(ir, fields, db, args, state), allRows)
  })

/**
 * Direct `.one()`: exactly one row, with the cardinality error observed (Finding 14).
 *
 * @typeParam A - Decoded row shape.
 * @param ir - Query representation. @param fields - Selection decoders.
 * @param db - Active database service. @param args - Named values.
 * @param operation - Diagnostic operation name.
 * @returns The single decoded row.
 */
export const executeOne = <A>(
  ir: QueryIR,
  fields: ReadonlyArray<SelectionField>,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<A, QueryError | NotFoundError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, ir, args, state, directRowsExecution<A>(ir, fields, db, args, state), (rows) =>
      exactlyOne(rows, operation)
    )
  })

/**
 * Direct `.maybeOne()`: zero or one row, with the cardinality error observed.
 *
 * @typeParam A - Decoded row shape.
 * @param ir - Query representation. @param fields - Selection decoders.
 * @param db - Active database service. @param args - Named values.
 * @param operation - Diagnostic operation name.
 * @returns `Option.none()` or `Option.some(row)`.
 */
export const executeMaybeOne = <A>(
  ir: QueryIR,
  fields: ReadonlyArray<SelectionField>,
  db: DatabaseService,
  args: QueryArgs,
  operation: string
): Effect.Effect<Option.Option<A>, QueryError | TooManyRowsError> =>
  Effect.suspend(() => {
    const state = observationState()
    return observeRefined(db, ir, args, state, directRowsExecution<A>(ir, fields, db, args, state), (rows) =>
      atMostOne(rows, operation)
    )
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
  Effect.suspend(() => {
    const state = observationState()
    const execution = Effect.gen(function* () {
      const caches = cachesFor(db)
      const shape = shapeVia(caches, ir)
      yield* guardForMode(caches, shape, db)
      state.compileCache = hasCompiled(caches, shape, db.dialect) ? "hit" : "miss"
      const compiled = compileVia(caches, shape, db.dialect)
      state.compiledSql = compiled.sql
      state.paramOrder = compiled.paramOrder
      const values = yield* bindValues(shape, compiled.paramOrder, args)
      state.values = values
      const prepared = yield* prepareForExecution(db, caches, compiled)
      state.preparedCache = prepared.outcome
      return yield* db.driver.execute(compiled.sql, values, prepared.name)
    })
    return observeQuery(db, ir, args, state, execution, (result) => result.rowCount)
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
  if (rows.length === 0)
    return Effect.fail(new NotFoundError({ message: `${operation}: expected one row, found none` }))
  if (rows.length > 1)
    return Effect.fail(
      new TooManyRowsError({ count: rows.length, message: `${operation}: expected one row, found ${rows.length}` })
    )
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
    return Effect.fail(
      new TooManyRowsError({
        count: rows.length,
        message: `${operation}: expected at most one row, found ${rows.length}`
      })
    )
  return Effect.succeed(rows.length === 0 ? Option.none() : Option.some(rows[0]!))
}

export { PreparedExecutionPlan }
export type { QueryArgs }
export type { PreparedDialectInspection, PreparedPlanInspection } from "./prepared-plan.js"
