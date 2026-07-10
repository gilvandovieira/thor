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
import { type DatabaseService } from "./database.js"
import { DEFAULT_EXECUTION_MODE, resolveDecodeMode } from "./plan.js"
import { observeQuery } from "../observability/index.js"
import {
  bindValues,
  cachesFor,
  compileVia,
  decodeForMode,
  guardForMode,
  hasCompiled,
  notePrepared,
  observationState,
  preparedNameFor,
  type QueryArgs,
  shapeVia
} from "./run-pipeline.js"
import { PreparedExecutionPlan } from "./prepared-plan.js"

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
): Effect.Effect<ReadonlyArray<A>, QueryError> => Effect.suspend(() => {
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
    state.preparedCache = notePrepared(db, cachesFor(db), compiled)
    const rows = yield* db.driver.query(compiled.sql, values, preparedNameFor(db, compiled))
    const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    return trusted ? rows as ReadonlyArray<A> : (yield* plan.decode(rows)) as ReadonlyArray<A>
  })
  return observeQuery(db, plan.ir, args, state, execution, (rows) => rows.length)
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
): Effect.Effect<CommandResult, QueryError> => Effect.suspend(() => {
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
    state.preparedCache = notePrepared(db, cachesFor(db), compiled)
    return yield* db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
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
 * @returns An Effect yielding decoded rows.
 */
export const executeCompiledRows = <A>(
  plan: PreparedExecutionPlan,
  compiled: CompiledStatement,
  db: DatabaseService,
  args: QueryArgs
): Effect.Effect<ReadonlyArray<A>, QueryError> => Effect.suspend(() => {
  const state = observationState()
  state.compileCache = "hit"
  state.compiledSql = compiled.sql
  state.paramOrder = compiled.paramOrder
  const execution = Effect.gen(function* () {
    const values = yield* plan.bind(compiled.paramOrder, args)
    state.values = values
    state.preparedCache = notePrepared(db, cachesFor(db), compiled)
    const rows = yield* db.driver.query(compiled.sql, values, preparedNameFor(db, compiled))
    const trusted = resolveDecodeMode(db.mode ?? DEFAULT_EXECUTION_MODE, db.decodeMode) === "trusted"
    return trusted ? rows as ReadonlyArray<A> : (yield* plan.decode(rows)) as ReadonlyArray<A>
  })
  return observeQuery(db, plan.ir, args, state, execution, (rows) => rows.length)
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
): Effect.Effect<CommandResult, QueryError> => Effect.suspend(() => {
  const state = observationState()
  state.compileCache = "hit"
  state.compiledSql = compiled.sql
  state.paramOrder = compiled.paramOrder
  const execution = Effect.flatMap(plan.bind(compiled.paramOrder, args), (values) => {
    state.values = values
    state.preparedCache = notePrepared(db, cachesFor(db), compiled)
    return db.driver.execute(compiled.sql, values, preparedNameFor(db, compiled))
  })
  return observeQuery(db, plan.ir, args, state, execution, (result) => result.rowCount)
})

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
): Effect.Effect<ReadonlyArray<A>, QueryError> => Effect.suspend(() => {
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
    const prepared = preparedNameFor(db, compiled)
    state.preparedCache = notePrepared(db, caches, compiled)
    const rows = yield* db.driver.query(compiled.sql, values, prepared)
    return (yield* decodeForMode(caches, fields, rows, db)) as ReadonlyArray<A>
  })
  return observeQuery(db, ir, args, state, execution, (rows) => rows.length)
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
): Effect.Effect<CommandResult, QueryError> => Effect.suspend(() => {
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
    const prepared = preparedNameFor(db, compiled)
    state.preparedCache = notePrepared(db, caches, compiled)
    return yield* db.driver.execute(compiled.sql, values, prepared)
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

export { PreparedExecutionPlan }
export type { QueryArgs }
export type { PreparedDialectInspection, PreparedPlanInspection } from "./prepared-plan.js"
