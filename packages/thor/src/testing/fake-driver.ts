/**
 * In-memory fake driver (spec §14.9). Records every compiled statement and its
 * bound params, and returns programmed responses — so tests can assert that SQL
 * was compiled, params were bound, and errors map correctly, all without a real
 * database.
 *
 * @module testing/fake-driver
 */
import { Effect } from "effect"
import type { CommandResult, Driver, RawRow } from "../execution/driver.js"
import type { ConstraintError, DriverError } from "../errors/index.js"
import { defineRuntimeRequirements } from "../capabilities/runtime.js"

/** Runtime-neutral contract for the in-memory fake adapter. */
export const FakeDriverRuntime = defineRuntimeRequirements("testing/fake", [])

/** One statement recorded by `FakeDriver`. */
export interface DriverCall {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

/** A programmed driver response: rows, a command tag, or a failure. */
export interface FakeResult {
  readonly rows?: ReadonlyArray<RawRow>
  readonly rowCount?: number
  readonly error?: DriverError | ConstraintError
}

/** Queue-driven in-memory driver for deterministic query tests. */
export class FakeDriver {
  /** Every statement the driver has been asked to run, in order. */
  readonly calls: DriverCall[] = []
  /** The prepared-statement name passed with each call (`undefined` if unprepared), aligned to `calls`. */
  readonly preparedNames: (string | undefined)[] = []
  private readonly queue: FakeResult[] = []

  /**
   * @param results - Responses consumed by subsequent calls.
   * @returns This driver for chaining.
   */
  enqueue(...results: ReadonlyArray<FakeResult>): this {
    this.queue.push(...results)
    return this
  }

  /**
   * @returns Nothing. Clears calls, prepared names, and queued responses.
   */
  reset(): void {
    this.calls.length = 0
    this.preparedNames.length = 0
    this.queue.length = 0
  }

  /**
   * @returns The next queued response, or an empty successful response.
   */
  private next(): FakeResult {
    return this.queue.shift() ?? {}
  }

  /**
   * @returns A `Driver` view backed by this recorder and response queue.
   */
  get driver(): Driver {
    const self = this
    return {
      runtime: FakeDriverRuntime,
      query: (sql, params, name) =>
        Effect.suspend(() => {
          self.calls.push({ sql, params })
          self.preparedNames.push(name)
          const result = self.next()
          return result.error ? Effect.fail(result.error) : Effect.succeed(result.rows ?? [])
        }),
      execute: (sql, params, name) =>
        Effect.suspend(() => {
          self.calls.push({ sql, params })
          self.preparedNames.push(name)
          const result = self.next()
          return result.error
            ? Effect.fail(result.error)
            : Effect.succeed<CommandResult>({ rowCount: result.rowCount ?? result.rows?.length ?? 0 })
        }),
      executeScript: (sql) =>
        Effect.suspend(() => {
          self.calls.push({ sql, params: [] })
          self.preparedNames.push(undefined)
          const result = self.next()
          return result.error
            ? Effect.fail(result.error)
            : Effect.succeed<CommandResult>({ rowCount: result.rowCount ?? result.rows?.length ?? 0 })
        })
    }
  }
}

/**
 * @param results - Initial queued responses.
 * @returns A configured fake driver.

 */
export const makeFakeDriver = (...results: ReadonlyArray<FakeResult>): FakeDriver =>
  new FakeDriver().enqueue(...results)
