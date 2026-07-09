/**
 * SQL feature matrix (spec §14.11).
 *
 * A growing, executable set of feature definitions exercised at multiple levels:
 *   - **unit** — compiled SQL snapshot per dialect + declared required capabilities;
 *   - **fake execution** — bound params, cardinality, decoding, typed errors.
 *
 * The matrix is capability-aware: a feature whose required capability is not
 * supported by the dialect under test must fail with `CapabilityError` before
 * the driver, and its SQL snapshot is omitted for that dialect. `LEVEL_1_2_FEATURES`
 * ships basic DML + typed-semantics; higher levels extend the same shape.
 *
 * @module testing/sql-features
 */
import { Effect, Either, type Layer, Option, Schema } from "effect"
import { db } from "../sql/query-builder.js"
import { withMode } from "../execution/plan.js"
import { and, eq, gt, isNull, or } from "../sql/predicates.js"
import { asc, desc, param } from "../sql/expressions.js"
import { defineTable } from "../schema/table.js"
import { integer, text, timestamp, uuid } from "../schema/index.js"
import type { Capability } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import type { Dialect } from "../dialect.js"
import { CapabilityError } from "../errors/index.js"
import type { CompiledQuery, RawRow } from "../execution/driver.js"
import { Database } from "../execution/database.js"
import type { QueryArgs } from "../execution/run.js"
import type { ContractTestApi } from "./contract-suite.js"
import { FakeDriver } from "./fake-driver.js"
import { FakeDatabaseLayer } from "./fake-database-layer.js"

/** Tables available to every feature's `build` function. */
const users = defineTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").nullable(),
  age: integer("age").nullable(),
  createdAt: timestamp("created_at").notNull().defaultNow()
})
/** Shared schema fixtures passed to every SQL feature definition. */
export const sqlFeatureFixtures = { users } as const

/** Type of the shared schema fixtures passed to SQL feature builders. */
export type SqlFeatureFixtures = typeof sqlFeatureFixtures

/** How a feature is executed against the driver. */
export type FeatureExec = "all" | "one" | "maybeOne" | "run"

/** One executable SQL feature definition (spec §14.11). */
export interface SqlFeature {
  /** Stable feature identifier used in generated test names. */
  readonly id: string
  /** SQL feature-matrix level from the specification. */
  readonly level: number
  /** Capabilities that must be available before execution. */
  readonly requires: ReadonlyArray<Capability>
  /**
   * @param t - Shared schema fixtures.
   * @returns A query builder exercising this feature.
   */
  readonly build: (t: SqlFeatureFixtures) => unknown
  /** Expected compiled SQL keyed by dialect id — only for supporting dialects. */
  readonly assertSql: Readonly<Record<string, string>>
  readonly exec?: FeatureExec
  readonly args?: QueryArgs
  readonly driverRows?: ReadonlyArray<RawRow>
  readonly driverRowCount?: number
  readonly assertResult?: unknown
}

/**
 * Identity helper documenting a feature definition.
 *
 * @param feature - Executable SQL feature definition.
 * @returns The same feature definition with its type checked.
 */
export const defineSqlFeatureSuite = (feature: SqlFeature): SqlFeature => feature

interface RunnableQuery {
  /**
   * @param dialect - Target SQL dialect.
   * @returns Compiled SQL and parameter metadata.
   */
  readonly toSql?: (dialect: Dialect) => CompiledQuery
  /** @returns Capabilities collected from the query IR. */
  readonly requiredCapabilities?: () => ReadonlyArray<Capability>
  /**
   * @param args - Values for named query parameters.
   * @returns An Effect executing a query with many-row cardinality.
   */
  readonly all?: (args?: QueryArgs) => Effect.Effect<unknown, unknown, Database>
  /**
   * @param args - Values for named query parameters.
   * @returns An Effect executing a query requiring exactly one row.
   */
  readonly one?: (args?: QueryArgs) => Effect.Effect<unknown, unknown, Database>
  /**
   * @param args - Values for named query parameters.
   * @returns An Effect executing a query allowing zero or one row.
   */
  readonly maybeOne?: (args?: QueryArgs) => Effect.Effect<unknown, unknown, Database>
  /**
   * @param args - Values for named query parameters.
   * @returns An Effect executing a mutation query.
   */
  readonly run?: (args?: QueryArgs) => Effect.Effect<unknown, unknown, Database>
}

/** Dialect and feature definitions registered by the matrix runner. */
export interface SqlFeatureMatrixOptions {
  /** Dialect used for compilation, capability checks, and fake execution. */
  readonly dialect: Dialect
  /** Executable feature definitions to register. */
  readonly features: ReadonlyArray<SqlFeature>
}

/**
 * Registers the capability-aware feature matrix for one dialect (spec §14.11).
 *
 * @param api - Test-runner registration and assertion functions.
 * @param options - Dialect and features to run.
 * @returns Nothing; tests are registered synchronously.
 */
export const runSqlFeatureMatrix = (api: ContractTestApi, options: SqlFeatureMatrixOptions): void => {
  const { describe, it, expect } = api
  const { dialect } = options

  describe(`sql feature matrix: ${dialect.id}`, () => {
    for (const feature of options.features) {
      const supported = feature.requires.every((capability) => isSatisfied(dialect.capabilities, capability))
      const expectedSql = feature.assertSql[dialect.id]
      const method: FeatureExec = feature.exec ?? "all"

      describe(`L${feature.level} ${feature.id}`, () => {
        if (expectedSql !== undefined) {
          it("compiles to the expected SQL", () => {
            const q = feature.build(sqlFeatureFixtures) as RunnableQuery
            expect(q.toSql?.(dialect).sql).toBe(expectedSql)
          })
        }

        it("declares its required capabilities", () => {
          const q = feature.build(sqlFeatureFixtures) as RunnableQuery
          expect(q.requiredCapabilities?.() ?? []).toEqual(feature.requires)
        })

        if (supported) {
          it("executes and decodes against the fake driver", async () => {
            const driver = new FakeDriver()
            if (feature.driverRows) driver.enqueue({ rows: feature.driverRows })
            else driver.enqueue({ rowCount: feature.driverRowCount ?? 0 })
            const q = feature.build(sqlFeatureFixtures) as RunnableQuery
            const result = await Effect.runPromise(
              Effect.provide(q[method]!(feature.args), FakeDatabaseLayer(driver, { dialect }))
            )
            expect(result).toEqual(feature.assertResult)
          })
        } else {
          it("fails with CapabilityError before the driver", async () => {
            const driver = new FakeDriver()
            const q = feature.build(sqlFeatureFixtures) as RunnableQuery
            const error = await Effect.runPromise(
              Effect.flip(Effect.provide(q[method]!(feature.args), FakeDatabaseLayer(driver, { dialect })))
            )
            expect(error).toBeInstanceOf(CapabilityError)
            expect(driver.calls).toEqual([])
          })
        }
      })
    }
  })
}

/** Live-layer integration options for the feature matrix (spec §14.11, level 3). */
export interface SqlFeatureIntegrationOptions {
  readonly dialect: Dialect
  readonly features: ReadonlyArray<SqlFeature>
  /** A live `Database` layer for the dialect under test. */
  readonly layer: Layer.Layer<Database>
  /** Dialect-specific statements run before each feature to (re)create + seed the `users` fixture. */
  readonly reset: ReadonlyArray<string>
  readonly setup?: () => void | Promise<void>
  readonly teardown?: () => void | Promise<void>
}

/**
 * Runs the feature matrix against a **real** dialect (spec §14.11 integration
 * level): it proves the generated SQL is actually valid for that backend.
 *
 * Execution uses `unsafe` mode so decode (a fixture-codec concern already covered
 * at the fake level) never masks a SQL-validity failure. A supported feature must
 * not surface a `DriverError` (the SQL parsed and ran); an unsupported feature
 * must fail with `CapabilityError` before the driver.
 *
 * @param api - Test-runner registration and assertion functions.
 * @param options - Dialect, features, live layer, and reset DDL.
 * @returns Nothing; tests are registered synchronously.
 */
export const runSqlFeatureIntegration = (api: ContractTestApi, options: SqlFeatureIntegrationOptions): void => {
  const { describe, it, beforeAll, afterAll, beforeEach, expect } = api
  const { dialect } = options
  const layer = withMode(options.layer, "unsafe")
  const script = (sql: string): Promise<unknown> =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Database, (d) => (d.driver.executeScript ? d.driver.executeScript(sql) : d.driver.execute(sql, []))),
        options.layer
      )
    )

  describe(`sql feature integration: ${dialect.id}`, () => {
    beforeAll(async () => {
      await options.setup?.()
    })
    afterAll(async () => {
      await options.teardown?.()
    })
    beforeEach(async () => {
      for (const statement of options.reset) await script(statement)
    })

    for (const feature of options.features) {
      const supported = feature.requires.every((capability) => isSatisfied(dialect.capabilities, capability))
      const method: FeatureExec = feature.exec ?? "all"

      if (supported) {
        it(`L${feature.level} ${feature.id} runs valid SQL on ${dialect.id}`, async () => {
          const q = feature.build(sqlFeatureFixtures) as RunnableQuery
          const result = await Effect.runPromise(Effect.either(Effect.provide(q[method]!(feature.args), layer)))
          if (Either.isLeft(result)) {
            // Cardinality/constraint errors mean the SQL executed; a DriverError means invalid SQL.
            const tag = (result.left as { readonly _tag?: string })._tag
            expect(tag !== "DriverError").toBe(true)
          }
        })
      } else {
        it(`L${feature.level} ${feature.id} rejects with CapabilityError on ${dialect.id}`, async () => {
          const q = feature.build(sqlFeatureFixtures) as RunnableQuery
          const error = await Effect.runPromise(Effect.flip(Effect.provide(q[method]!(feature.args), layer)))
          expect(error).toBeInstanceOf(CapabilityError)
        })
      }
    }
  })
}

const emailParam = param("email", Schema.String)

/** Level 1 (basic DML) + Level 2 (typed semantics) features (spec §14.11). */
export const LEVEL_1_2_FEATURES: ReadonlyArray<SqlFeature> = [
  defineSqlFeatureSuite({
    id: "select.projection",
    level: 1,
    requires: [],
    build: ({ users }) => db.select({ id: users.id, email: users.email }).from(users),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id", "users"."email" AS "email" FROM "users"',
      sqlite: 'SELECT "users"."id" AS "id", "users"."email" AS "email" FROM "users"',
      mysql: "SELECT `users`.`id` AS `id`, `users`.`email` AS `email` FROM `users`"
    },
    exec: "all",
    driverRows: [{ id: "u1", email: "a@b.c" }],
    assertResult: [{ id: "u1", email: "a@b.c" }]
  }),
  defineSqlFeatureSuite({
    id: "select.where.eq",
    level: 1,
    requires: [],
    build: ({ users }) => db.select({ id: users.id }).from(users).where(eq(users.email, emailParam)),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" WHERE "users"."email" = $1',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" WHERE "users"."email" = ?',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`email` = ?"
    },
    exec: "one",
    args: { email: "a@b.c" },
    driverRows: [{ id: "u1" }],
    assertResult: { id: "u1" }
  }),
  defineSqlFeatureSuite({
    id: "select.where.andOr",
    level: 1,
    requires: [],
    build: ({ users }) =>
      db.select({ id: users.id }).from(users).where(and(eq(users.email, emailParam), or(gt(users.age, 18), isNull(users.age)))),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = $1 AND ("users"."age" > $2 OR "users"."age" IS NULL))',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = ? AND ("users"."age" > ? OR "users"."age" IS NULL))',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` WHERE (`users`.`email` = ? AND (`users`.`age` > ? OR `users`.`age` IS NULL))"
    },
    exec: "all",
    args: { email: "a@b.c" },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.orderLimitOffset",
    level: 1,
    requires: [],
    build: ({ users }) => db.select({ id: users.id }).from(users).orderBy(desc(users.age), asc(users.id)).limit(10).offset(5),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" ORDER BY "users"."age" DESC, "users"."id" ASC LIMIT 10 OFFSET 5',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" ORDER BY "users"."age" DESC, "users"."id" ASC LIMIT 10 OFFSET 5',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` ORDER BY `users`.`age` DESC, `users`.`id` ASC LIMIT 10 OFFSET 5"
    },
    exec: "all",
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "insert.one",
    level: 1,
    requires: [],
    build: ({ users }) => db.insert(users).values({ email: "a@b.c", name: "A" }),
    assertSql: {},
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  }),
  defineSqlFeatureSuite({
    id: "update.where",
    level: 1,
    requires: [],
    build: ({ users }) => db.update(users).set({ name: "N" }).where(eq(users.email, emailParam)),
    assertSql: {},
    exec: "run",
    args: { email: "a@b.c" },
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  }),
  defineSqlFeatureSuite({
    id: "delete.where",
    level: 1,
    requires: [],
    build: ({ users }) => db.delete(users).where(eq(users.email, emailParam)),
    assertSql: {},
    exec: "run",
    args: { email: "a@b.c" },
    driverRowCount: 2,
    assertResult: { rowCount: 2 }
  }),
  defineSqlFeatureSuite({
    id: "select.nullable",
    level: 2,
    requires: [],
    build: ({ users }) => db.select({ name: users.name }).from(users),
    assertSql: {
      postgres: 'SELECT "users"."name" AS "name" FROM "users"',
      sqlite: 'SELECT "users"."name" AS "name" FROM "users"',
      mysql: "SELECT `users`.`name` AS `name` FROM `users`"
    },
    exec: "all",
    driverRows: [{ name: null }],
    assertResult: [{ name: null }]
  }),
  defineSqlFeatureSuite({
    id: "select.maybeOne.empty",
    level: 2,
    requires: [],
    build: ({ users }) => db.select({ id: users.id }).from(users),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users"',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users"',
      mysql: "SELECT `users`.`id` AS `id` FROM `users`"
    },
    exec: "maybeOne",
    driverRows: [],
    assertResult: Option.none()
  }),
  defineSqlFeatureSuite({
    id: "insert.returning",
    level: 2,
    requires: ["insert.returning"],
    build: ({ users }) => db.insert(users).values({ email: "a@b.c" }).returning({ id: users.id }),
    assertSql: {
      postgres: 'INSERT INTO "users" ("email") VALUES ($1) RETURNING "users"."id" AS "id"',
      sqlite: 'INSERT INTO "users" ("email") VALUES (?) RETURNING "users"."id" AS "id"'
    },
    exec: "one",
    driverRows: [{ id: "new" }],
    assertResult: { id: "new" }
  }),
  defineSqlFeatureSuite({
    id: "update.returning",
    level: 2,
    requires: ["update.returning"],
    build: ({ users }) => db.update(users).set({ name: "N" }).where(eq(users.email, emailParam)).returning({ id: users.id }),
    assertSql: {
      postgres: 'UPDATE "users" SET "name" = $1 WHERE "users"."email" = $2 RETURNING "users"."id" AS "id"',
      sqlite: 'UPDATE "users" SET "name" = ? WHERE "users"."email" = ? RETURNING "users"."id" AS "id"'
    },
    exec: "one",
    args: { email: "a@b.c" },
    driverRows: [{ id: "u1" }],
    assertResult: { id: "u1" }
  }),
  defineSqlFeatureSuite({
    id: "delete.returning",
    level: 2,
    requires: ["delete.returning"],
    build: ({ users }) => db.delete(users).where(eq(users.email, emailParam)).returning({ id: users.id }),
    assertSql: {
      postgres: 'DELETE FROM "users" WHERE "users"."email" = $1 RETURNING "users"."id" AS "id"',
      sqlite: 'DELETE FROM "users" WHERE "users"."email" = ? RETURNING "users"."id" AS "id"'
    },
    exec: "all",
    args: { email: "a@b.c" },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  })
]
