/**
 * A `Database` layer backed by the fake driver (spec §14.2). Provide this to
 * `Effect.provide` and run any query without a real database.
 *
 * @module testing/fake-database-layer
 */
import { Layer } from "effect"
import { Database, type DatabaseService } from "../execution/database.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"
import { FakeDriver } from "./fake-driver.js"

/** Options controlling the fake layer's dialect and execution policies. */
export interface FakeDatabaseOptions {
  /** Dialect whose capability matrix guards run against (default Postgres). */
  readonly dialect?: Dialect
  /** Whether `emulated` capabilities satisfy guards (default false). */
  readonly allowEmulation?: boolean
  /** Whether parameterized queries carry a prepared-statement name (default true). */
  readonly preparedStatements?: boolean
}

/**
 * Build a `Database` layer plus the `FakeDriver` that backs it (so tests can
 * inspect `.calls` after running).
 *
 * @param options - Dialect, emulation, and prepared-statement options.
 * @returns A fake `Database` layer and its backing recorder.
 */
export const makeFakeDatabase = (
  options: FakeDatabaseOptions = {}
): { readonly layer: Layer.Layer<Database>; readonly driver: FakeDriver } => {
  const driver = new FakeDriver()
  const service: DatabaseService = {
    dialect: options.dialect ?? PostgresDialect,
    driver: driver.driver,
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  }
  return { layer: Layer.succeed(Database, service), driver }
}

/**
 * @param driver - Existing fake driver to expose through `Database`.
 * @param options - Dialect, emulation, and prepared-statement options.
 * @returns An Effect layer providing `Database`.
 */
export const FakeDatabaseLayer = (driver: FakeDriver, options: FakeDatabaseOptions = {}): Layer.Layer<Database> =>
  Layer.succeed(Database, {
    dialect: options.dialect ?? PostgresDialect,
    driver: driver.driver,
    allowEmulation: options.allowEmulation ?? false,
    preparedStatements: options.preparedStatements ?? true
  })
