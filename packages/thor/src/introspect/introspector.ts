/**
 * The `Introspector` service (spec §16.3).
 *
 * Reads a live database's shape into the dialect-neutral {@link IntrospectedSchema}
 * by dispatching to the per-dialect strategy for the active `Database`'s dialect.
 * Introspection verifies and compares against schema-as-code; it never replaces it.
 *
 * @module introspect/introspector
 */
import { Context, Effect, Layer } from "effect"
import type { ConstraintError, DriverError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import type { AnyTable } from "../schema/table.js"
import { type DriftOptions, type DriftReport, detectDrift } from "./drift.js"
import { MySQLIntrospection } from "./mysql.js"
import { PostgresIntrospection } from "./postgres.js"
import type { DialectIntrospection, IntrospectedSchema, IntrospectionQuery } from "./schema-ir.js"
import { SQLiteIntrospection } from "./sqlite.js"

/** Per-dialect introspection strategies keyed by dialect id. */
const STRATEGIES: Record<string, DialectIntrospection> = {
  postgres: PostgresIntrospection,
  sqlite: SQLiteIntrospection,
  mysql: MySQLIntrospection
}

/** Programmatic introspection API (spec §16.3). */
export interface IntrospectorService {
  /**
   * Read the live database's current shape.
   *
   * @returns The introspected schema (tables, columns, primary keys, foreign keys).
   */
  readonly currentSchema: () => Effect.Effect<IntrospectedSchema, DriverError | ConstraintError>
  /**
   * Diff the live database against schema-as-code (spec §16.5).
   *
   * @param expected - Schema-as-code tables.
   * @param options - Drift options (e.g. ignored tables).
   * @returns A drift report; `inSync` is `true` when the database matches the schema.
   */
  readonly drift: (
    expected: ReadonlyArray<AnyTable>,
    options?: DriftOptions
  ) => Effect.Effect<DriftReport, DriverError | ConstraintError>
}

/** Effect context tag for the introspection service. */
export class Introspector extends Context.Tag("thor/Introspector")<Introspector, IntrospectorService>() {}

/**
 * Build an introspector bound to the ambient `Database` service.
 *
 * @returns An Effect yielding a reusable introspector.
 */
export const makeIntrospector = (): Effect.Effect<IntrospectorService, never, Database> =>
  Effect.gen(function* () {
    const db = yield* Database
    const strategy = STRATEGIES[db.dialect.id]
    const query: IntrospectionQuery = (sql) => db.driver.query(sql, [])
    const currentSchema = (): Effect.Effect<IntrospectedSchema, DriverError | ConstraintError> =>
      strategy
        ? strategy.currentSchema(query)
        : Effect.dieMessage(`No introspection strategy for dialect "${db.dialect.id}"`)
    return {
      currentSchema,
      drift: (expected, options) => Effect.map(currentSchema(), (live) => detectDrift(expected, live, options))
    }
  })

/**
 * A layer providing the {@link Introspector} over a `Database`.
 */
export const IntrospectorLive: Layer.Layer<Introspector, never, Database> = Layer.effect(Introspector, makeIntrospector())
