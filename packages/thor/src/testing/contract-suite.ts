/**
 * Shared dialect/driver contract suite (spec §14.10).
 *
 * Every driver adapter must pass this identical suite against a real database.
 * The suite is test-runner-agnostic: the caller injects `describe/it/expect/...`
 * (so the shipped package takes no test-framework dependency) plus a
 * `Layer<Database>` for the driver under test.
 *
 *   makeDialectContractSuite(
 *     { describe, it, beforeAll, afterAll, beforeEach, expect },
 *     { name: "node-postgres", layer: PostgresLayer(client), setup, teardown }
 *   )
 *
 * @module testing/contract-suite
 */
import { Effect, Schema, type Layer } from "effect"
import { db } from "../sql/query-builder.js"
import { eq } from "../sql/predicates.js"
import { param } from "../sql/expressions.js"
import { excluded } from "../sql/advanced-expressions.js"
import { defineTable } from "../schema/table.js"
import { integer, text, uuid } from "../schema/index.js"
import { Database } from "../execution/database.js"
import { CapabilityError, ConstraintError } from "../errors/index.js"
import type { Capability } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import type { Dialect } from "../dialect.js"
import {
  detectRuntimeCapabilities,
  missingRuntimeCapabilities,
  type RuntimeRequirements
} from "../capabilities/runtime.js"

/** Minimal matcher interface required by the runner-agnostic suite. */
export interface ContractExpectation {
  /**
   * @param expected - Value compared with identity semantics.
   * @returns Nothing.
   */
  toBe(expected: unknown): void
  /**
   * @param expected - Value compared with deep-equality semantics.
   * @returns Nothing.
   */
  toEqual(expected: unknown): void
  /**
   * @param expected - Constructor expected for the received value.
   * @returns Nothing.
   */
  toBeInstanceOf(expected: unknown): void
}

/** Test-runner functions injected by Vitest, Jest, or another compatible runner. */
export interface ContractTestApi {
  /**
   * @param name - Suite title.
   * @param fn - Synchronous suite registration callback.
   * @returns Nothing.
   */
  readonly describe: (name: string, fn: () => void) => void
  /**
   * @param name - Test title.
   * @param fn - Test body.
   * @returns Nothing.
   */
  readonly it: (name: string, fn: () => void | Promise<void>) => void
  /**
   * @param fn - Suite setup callback.
   * @returns Nothing.
   */
  readonly beforeAll: (fn: () => void | Promise<void>) => void
  /**
   * @param fn - Suite teardown callback.
   * @returns Nothing.
   */
  readonly afterAll: (fn: () => void | Promise<void>) => void
  /**
   * @param fn - Per-test setup callback.
   * @returns Nothing.
   */
  readonly beforeEach: (fn: () => void | Promise<void>) => void
  /**
   * @param actual - Value received by the matcher set.
   * @returns Minimal contract matchers.
   */
  readonly expect: (actual: any) => ContractExpectation
}

/** Lifecycle, dialect, and database layer for one driver contract run. */
export interface DialectContractOptions {
  /** Human-readable driver name (used in the describe title). */
  readonly name: string
  /** A `Database` layer backed by the driver under test. */
  readonly layer: Layer.Layer<Database>
  /**
   * Dialect under test. Drives capability-aware gating (spec §14.11): a case
   * whose required capability is unsupported asserts a `CapabilityError` before
   * the driver instead of an execution result.
   */
  readonly dialect: Dialect
  /**
   * Dialect-specific statements run in order before each test to reset and
   * recreate the fixture (single statements each; the fixture's `id` is
   * server-assigned so inserts omit it). Kept out of the shared suite so the
   * suite stays dialect-agnostic.
   */
  readonly reset: ReadonlyArray<string>
  /** Whether emulated capabilities count as supported (default false). */
  readonly allowEmulation?: boolean
  /** Runtime contract the tested adapter must declare and satisfy on this host. */
  readonly runtime?: RuntimeRequirements
  /** @returns Optional setup completion. */
  readonly setup?: () => void | Promise<void>
  /** @returns Optional teardown completion. */
  readonly teardown?: () => void | Promise<void>
}

/**
 * Fixture table shared by every contract case. `id` carries a default so inserts
 * omit it, letting each dialect assign it however it likes (uuid default,
 * autoincrement rowid, `auto_increment`); the tests never read `id`.
 */
const users = defineTable("contract_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").nullable(),
  age: integer("age").nullable()
})

/**
 * Registers the shared, capability-aware live-driver contract suite (spec §14.10,
 * §14.11, §18.6). Every dialect adapter must pass this identical suite; only the
 * fixture DDL (`options.reset`) and capability-gated `RETURNING` expectations
 * differ per dialect.
 *
 * @experimental Advanced contract-suite registration may evolve with the feature matrix.
 * @param api - Test-runner registration and assertion functions.
 * @param options - Driver name, dialect, layer, reset DDL, and lifecycle hooks.
 * @returns Nothing; tests are registered synchronously.
 */
export const makeDialectContractSuite = (api: ContractTestApi, options: DialectContractOptions): void => {
  const { describe, it, beforeAll, afterAll, beforeEach, expect } = api
  const capabilities = options.dialect.capabilities
  const allowEmulation = options.allowEmulation ?? false
  const supports = (capability: Capability): boolean => isSatisfied(capabilities, capability, allowEmulation)

  const run = <A, E>(effect: Effect.Effect<A, E, Database>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, options.layer))
  // Raw SQL for fixtures and transaction control, portable across drivers.
  const script = (sql: string): Promise<unknown> =>
    run(
      Effect.flatMap(Database, (d) =>
        d.driver.executeScript ? d.driver.executeScript(sql) : d.driver.execute(sql, [])
      )
    )

  describe(`driver contract: ${options.name}`, () => {
    beforeAll(async () => {
      await options.setup?.()
    })
    afterAll(async () => {
      await options.teardown?.()
    })
    beforeEach(async () => {
      for (const statement of options.reset) await script(statement)
    })

    if (options.runtime) {
      it("declares and satisfies its host runtime contract", async () => {
        const service = await run(Database)
        expect(service.driver.runtime).toBe(options.runtime)
        expect(missingRuntimeCapabilities(service.driver.runtime, detectRuntimeCapabilities())).toEqual([])
      })
    }

    it("insert then select round-trips a row", async () => {
      await run(db.insert(users).values({ email: "a@example.com", name: "Ada" }).run())
      const rows = await run(db.select({ email: users.email, name: users.name }).from(users).all())
      expect(rows).toEqual([{ email: "a@example.com", name: "Ada" }])
    })

    it("selects with a bound named parameter", async () => {
      await run(
        db
          .insert(users)
          .values([
            { email: "x@example.com", name: "X" },
            { email: "y@example.com", name: "Y" }
          ])
          .run()
      )
      const found = await run(
        db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.email, param("email", Schema.String)))
          .one({ email: "y@example.com" })
      )
      expect(found).toEqual({ name: "Y" })
    })

    it("commits through the transaction-scoped API", async () => {
      await run(db.transaction(db.insert(users).values({ email: "c@example.com" }).run()))
      const rows = await run(db.select({ email: users.email }).from(users).all())
      expect(rows).toEqual([{ email: "c@example.com" }])
    })

    it("rolls failed transaction-scoped work back", async () => {
      await run(
        Effect.either(
          db.transaction(
            Effect.zipRight(db.insert(users).values({ email: "rb@example.com" }).run(), Effect.fail("rollback"))
          )
        )
      )
      const rows = await run(db.select({ email: users.email }).from(users).all())
      expect(rows).toEqual([])
    })

    if (supports("transaction.savepoints")) {
      it("executes nested transactions through savepoints", async () => {
        await run(db.transaction(db.transaction(db.insert(users).values({ email: "nested@example.com" }).run())))
        const rows = await run(db.select({ email: users.email }).from(users).all())
        expect(rows).toEqual([{ email: "nested@example.com" }])
      })
    }

    it("maps a unique-constraint violation to a tagged ConstraintError", async () => {
      await run(db.insert(users).values({ email: "dup@example.com" }).run())
      const error = await run(Effect.flip(db.insert(users).values({ email: "dup@example.com" }).run()))
      expect(error).toBeInstanceOf(ConstraintError)
      expect((error as ConstraintError).kind).toBe("unique")
    })

    it("decodes integers, nullable columns, and text together", async () => {
      await run(db.insert(users).values({ email: "n@example.com", name: null, age: 41 }).run())
      const row = await run(db.select({ name: users.name, age: users.age }).from(users).one())
      expect(row).toEqual({ name: null, age: 41 })
    })

    it("updates and deletes rows without RETURNING", async () => {
      await run(db.insert(users).values({ email: "plain@example.com", name: "Old" }).run())
      const updated = await run(
        db
          .update(users)
          .set({ name: "New" })
          .where(eq(users.email, param("email", Schema.String)))
          .run({ email: "plain@example.com" })
      )
      expect(updated.rowCount).toBe(1)
      const row = await run(db.select({ name: users.name }).from(users).one())
      expect(row).toEqual({ name: "New" })
      const removed = await run(
        db
          .delete(users)
          .where(eq(users.email, param("deleteEmail", Schema.String)))
          .run({ deleteEmail: "plain@example.com" })
      )
      expect(removed.rowCount).toBe(1)
      expect(await run(db.select({ email: users.email }).from(users).all())).toEqual([])
    })

    if (supports("insert.onConflict")) {
      it("executes ON CONFLICT update semantics", async () => {
        await run(db.insert(users).values({ email: "conflict@example.com", name: "Old" }).run())
        await run(
          db
            .insert(users)
            .values({ email: "conflict@example.com", name: "New" })
            .onConflictDoUpdate([users.email], { name: excluded(users.name) })
            .run()
        )
        expect(await run(db.select({ name: users.name }).from(users).one())).toEqual({ name: "New" })
      })
    }

    if (supports("insert.onDuplicateKey")) {
      it("executes ON DUPLICATE KEY update semantics", async () => {
        await run(db.insert(users).values({ email: "duplicate@example.com", name: "Old" }).run())
        await run(
          db
            .insert(users)
            .values({ email: "duplicate@example.com", name: "New" })
            .onDuplicateKeyUpdate({ name: excluded(users.name) })
            .run()
        )
        expect(await run(db.select({ name: users.name }).from(users).one())).toEqual({ name: "New" })
      })
    }

    // --- capability-gated RETURNING cases (spec §14.11) ----------------------

    if (supports("insert.returning")) {
      it("insert ... returning decodes the inserted row", async () => {
        const row = await run(
          db
            .insert(users)
            .values({ email: "r@example.com", name: "Rae" })
            .returning({ email: users.email, name: users.name })
            .one()
        )
        expect(row).toEqual({ email: "r@example.com", name: "Rae" })
      })
    } else {
      it("insert ... returning fails with CapabilityError before the driver", async () => {
        const error = await run(
          Effect.flip(db.insert(users).values({ email: "r@example.com" }).returning({ email: users.email }).one())
        )
        expect(error).toBeInstanceOf(CapabilityError)
      })
    }

    if (supports("update.returning")) {
      it("update ... returning reflects the change", async () => {
        await run(db.insert(users).values({ email: "u@example.com", name: "Old" }).run())
        const updated = await run(
          db
            .update(users)
            .set({ name: "New" })
            .where(eq(users.email, param("email", Schema.String)))
            .returning({ email: users.email, name: users.name })
            .one({ email: "u@example.com" })
        )
        expect(updated).toEqual({ email: "u@example.com", name: "New" })
      })
    } else {
      it("update ... returning fails with CapabilityError before the driver", async () => {
        const error = await run(
          Effect.flip(db.update(users).set({ name: "New" }).returning({ email: users.email }).one())
        )
        expect(error).toBeInstanceOf(CapabilityError)
      })
    }

    if (supports("delete.returning")) {
      it("delete ... returning yields the removed rows and empties the table", async () => {
        await run(db.insert(users).values({ email: "d@example.com", name: "Dee" }).run())
        const removed = await run(
          db
            .delete(users)
            .where(eq(users.email, param("email", Schema.String)))
            .returning({ email: users.email })
            .all({ email: "d@example.com" })
        )
        expect(removed).toEqual([{ email: "d@example.com" }])
        const remaining = await run(db.select({ email: users.email }).from(users).all())
        expect(remaining).toEqual([])
      })
    } else {
      it("delete ... returning fails with CapabilityError before the driver", async () => {
        const error = await run(Effect.flip(db.delete(users).returning({ email: users.email }).all()))
        expect(error).toBeInstanceOf(CapabilityError)
      })
    }
  })
}
