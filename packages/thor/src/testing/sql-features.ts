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
import { avg, count, excluded, exists, max, min, rowNumber, scalar, sum } from "../sql/advanced-expressions.js"
import { alias, defineTable } from "../schema/table.js"
import { integer, text, timestamp, uuid } from "../schema/index.js"
import type { Capability } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import type { Dialect } from "../dialect.js"
import { CapabilityError } from "../errors/index.js"
import type { CompiledQuery, RawRow } from "../execution/driver.js"
import { Database } from "../execution/database.js"
import type { QueryArgs } from "../execution/run.js"
import {
  defineAggregateFunction,
  defineFunction,
  defineProcedure,
  defineTableFunction
} from "../routine/index.js"
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
const posts = defineTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  title: text("title").notNull()
})
/** Shared schema fixtures passed to every SQL feature definition. */
export const sqlFeatureFixtures = { users, posts } as const

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
  /** Dialect used for compilation, capability checks, and live execution. */
  readonly dialect: Dialect
  /** Executable feature definitions to register. */
  readonly features: ReadonlyArray<SqlFeature>
  /** A live `Database` layer for the dialect under test. */
  readonly layer: Layer.Layer<Database>
  /** Dialect-specific statements run before each feature to (re)create + seed the `users` fixture. */
  readonly reset: ReadonlyArray<string>
  /** @returns Optional live-database setup completion. */
  readonly setup?: () => void | Promise<void>
  /** @returns Optional live-database teardown completion. */
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
const textArg = { dataType: "text" as const, codec: Schema.String }
const integerArg = { dataType: "integer" as const, codec: Schema.Number }
const lowerRoutine = defineFunction("lower", {
  args: [textArg],
  returns: textArg,
  volatility: "immutable"
})
const sumRoutine = defineAggregateFunction("sum", {
  args: [integerArg],
  returns: integerArg,
  volatility: "immutable"
})
const seriesRoutine = defineTableFunction("generate_series", {
  args: { start: integerArg, stop: integerArg },
  returns: { value: integerArg },
  volatility: "immutable"
})
const cleanupRoutine = defineProcedure("maintenance.cleanup", {
  args: { before: textArg },
  effects: {
    mutates: ["users"],
    idempotency: "idempotent",
    requiresTransaction: false
  }
})

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

/** Epic J feature definitions spanning matrix Levels 3, 4, 5, and 7. */
export const ADVANCED_SQL_FEATURES: ReadonlyArray<SqlFeature> = [
  defineSqlFeatureSuite({
    id: "join.inner.alias",
    level: 3,
    requires: [],
    build: ({ users, posts }) => {
      const p = alias(posts, "p")
      return db.select({ email: users.email, title: p.title }).from(users).join(p, eq(users.id, p.userId))
    },
    assertSql: {
      postgres: 'SELECT "users"."email" AS "email", "p"."title" AS "title" FROM "users" INNER JOIN "posts" "p" ON "users"."id" = "p"."user_id"',
      sqlite: 'SELECT "users"."email" AS "email", "p"."title" AS "title" FROM "users" INNER JOIN "posts" "p" ON "users"."id" = "p"."user_id"',
      mysql: "SELECT `users`.`email` AS `email`, `p`.`title` AS `title` FROM `users` INNER JOIN `posts` `p` ON `users`.`id` = `p`.`user_id`"
    },
    driverRows: [{ email: "a@b.c", title: "Hello" }],
    assertResult: [{ email: "a@b.c", title: "Hello" }]
  }),
  defineSqlFeatureSuite({
    id: "subquery.exists.correlated",
    level: 3,
    requires: [],
    build: ({ users, posts }) => {
      const matching = db.select({ id: posts.id }).from(posts).where(eq(posts.userId, users.id))
      return db.select({ id: users.id }).from(users).where(exists(matching))
    },
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" WHERE EXISTS (SELECT "posts"."id" AS "id" FROM "posts" WHERE "posts"."user_id" = "users"."id")',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" WHERE EXISTS (SELECT "posts"."id" AS "id" FROM "posts" WHERE "posts"."user_id" = "users"."id")',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` WHERE EXISTS (SELECT `posts`.`id` AS `id` FROM `posts` WHERE `posts`.`user_id` = `users`.`id`)"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "aggregate.group.having",
    level: 4,
    requires: [],
    build: ({ users }) => db
      .select({ email: users.email, total: count() })
      .from(users)
      .groupBy(users.email)
      .having(gt(count(), 0)),
    assertSql: {
      postgres: 'SELECT "users"."email" AS "email", COUNT(*) AS "total" FROM "users" GROUP BY "users"."email" HAVING COUNT(*) > $1',
      sqlite: 'SELECT "users"."email" AS "email", COUNT(*) AS "total" FROM "users" GROUP BY "users"."email" HAVING COUNT(*) > ?',
      mysql: "SELECT `users`.`email` AS `email`, COUNT(*) AS `total` FROM `users` GROUP BY `users`.`email` HAVING COUNT(*) > ?"
    },
    driverRows: [{ email: "a@b.c", total: 1 }],
    assertResult: [{ email: "a@b.c", total: 1 }]
  }),
  defineSqlFeatureSuite({
    id: "select.cte",
    level: 5,
    requires: ["select.cte"],
    build: ({ users }) => {
      const active = db.cte("active_users", db.select({ id: users.id }).from(users).where(gt(users.age, 17)))
      return db.select({ id: active.field("id") }).from(active)
    },
    assertSql: {
      postgres: 'WITH "active_users" AS (SELECT "users"."id" AS "id" FROM "users" WHERE "users"."age" > $1) SELECT "active_users"."id" AS "id" FROM "active_users"',
      sqlite: 'WITH "active_users" AS (SELECT "users"."id" AS "id" FROM "users" WHERE "users"."age" > ?) SELECT "active_users"."id" AS "id" FROM "active_users"',
      mysql: "WITH `active_users` AS (SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`age` > ?) SELECT `active_users`.`id` AS `id` FROM `active_users`"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.window.rowNumber",
    level: 5,
    requires: ["select.windowFunctions"],
    build: ({ users }) => db.select({
      id: users.id,
      row: rowNumber().over({ orderBy: [asc(users.createdAt)] })
    }).from(users),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id", ROW_NUMBER() OVER (ORDER BY "users"."created_at" ASC) AS "row" FROM "users"',
      sqlite: 'SELECT "users"."id" AS "id", ROW_NUMBER() OVER (ORDER BY "users"."created_at" ASC) AS "row" FROM "users"',
      mysql: "SELECT `users`.`id` AS `id`, ROW_NUMBER() OVER (ORDER BY `users`.`created_at` ASC) AS `row` FROM `users`"
    },
    driverRows: [{ id: "u1", row: 1 }],
    assertResult: [{ id: "u1", row: 1 }]
  }),
  defineSqlFeatureSuite({
    id: "select.set.union",
    level: 5,
    requires: ["select.setOperations"],
    build: ({ users }) => db.select({ id: users.id }).from(users)
      .union(db.select({ id: users.id }).from(users).where(isNull(users.name))),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" UNION SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" UNION SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` UNION SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`name` IS NULL"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "join.full",
    level: 3,
    requires: ["select.fullJoin"],
    build: ({ users, posts }) => db
      .select({ email: users.email, title: posts.title })
      .from(users)
      .fullJoin(posts, eq(users.id, posts.userId)),
    assertSql: {
      postgres: 'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" FULL JOIN "posts" ON "users"."id" = "posts"."user_id"',
      sqlite: 'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" FULL JOIN "posts" ON "users"."id" = "posts"."user_id"'
    },
    driverRows: [{ email: "a@b.c", title: "Hello" }],
    assertResult: [{ email: "a@b.c", title: "Hello" }]
  }),
  defineSqlFeatureSuite({
    id: "subquery.from.scalar",
    level: 3,
    requires: [],
    build: ({ users }) => {
      const selected = db.select({ id: users.id }).from(users).as("selected")
      const first = db.select({ id: users.id }).from(users).limit(1)
      return db.select({ id: selected.field("id") }).from(selected).where(eq(selected.field("id"), scalar(first)))
    },
    assertSql: {
      postgres: 'SELECT "selected"."id" AS "id" FROM (SELECT "users"."id" AS "id" FROM "users") "selected" WHERE "selected"."id" = (SELECT "users"."id" AS "id" FROM "users" LIMIT 1)',
      sqlite: 'SELECT "selected"."id" AS "id" FROM (SELECT "users"."id" AS "id" FROM "users") "selected" WHERE "selected"."id" = (SELECT "users"."id" AS "id" FROM "users" LIMIT 1)',
      mysql: "SELECT `selected`.`id` AS `id` FROM (SELECT `users`.`id` AS `id` FROM `users`) `selected` WHERE `selected`.`id` = (SELECT `users`.`id` AS `id` FROM `users` LIMIT 1)"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "aggregate.functions",
    level: 4,
    requires: [],
    build: ({ users }) => db.select({
      count: count(users.id),
      sum: sum(users.age),
      avg: avg(users.age),
      min: min(users.age),
      max: max(users.age)
    }).from(users),
    assertSql: {
      postgres: 'SELECT COUNT("users"."id") AS "count", SUM("users"."age") AS "sum", AVG("users"."age") AS "avg", MIN("users"."age") AS "min", MAX("users"."age") AS "max" FROM "users"',
      sqlite: 'SELECT COUNT("users"."id") AS "count", SUM("users"."age") AS "sum", AVG("users"."age") AS "avg", MIN("users"."age") AS "min", MAX("users"."age") AS "max" FROM "users"',
      mysql: "SELECT COUNT(`users`.`id`) AS `count`, SUM(`users`.`age`) AS `sum`, AVG(`users`.`age`) AS `avg`, MIN(`users`.`age`) AS `min`, MAX(`users`.`age`) AS `max` FROM `users`"
    },
    driverRows: [{ count: 1, sum: 30, avg: 30, min: 30, max: 30 }],
    assertResult: [{ count: 1, sum: 30, avg: 30, min: 30, max: 30 }]
  }),
  defineSqlFeatureSuite({
    id: "select.recursiveCte",
    level: 5,
    requires: ["select.recursiveCte"],
    build: ({ users }) => {
      const selected = db.recursiveCte("selected_users", db.select({ id: users.id }).from(users))
      return db.select({ id: selected.field("id") }).from(selected)
    },
    assertSql: {
      postgres: 'WITH RECURSIVE "selected_users" AS (SELECT "users"."id" AS "id" FROM "users") SELECT "selected_users"."id" AS "id" FROM "selected_users"',
      sqlite: 'WITH RECURSIVE "selected_users" AS (SELECT "users"."id" AS "id" FROM "users") SELECT "selected_users"."id" AS "id" FROM "selected_users"',
      mysql: "WITH RECURSIVE `selected_users` AS (SELECT `users`.`id` AS `id` FROM `users`) SELECT `selected_users`.`id` AS `id` FROM `selected_users`"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.lateral",
    level: 5,
    requires: ["select.lateralJoin"],
    build: ({ users, posts }) => {
      const matching = db.select({ title: posts.title }).from(posts).where(eq(posts.userId, users.id)).as("matching")
      return db.select({ email: users.email, title: matching.field("title") }).from(users).lateralJoin(matching)
    },
    assertSql: {
      postgres: 'SELECT "users"."email" AS "email", "matching"."title" AS "title" FROM "users" CROSS JOIN LATERAL (SELECT "posts"."title" AS "title" FROM "posts" WHERE "posts"."user_id" = "users"."id") "matching"',
      mysql: "SELECT `users`.`email` AS `email`, `matching`.`title` AS `title` FROM `users` CROSS JOIN LATERAL (SELECT `posts`.`title` AS `title` FROM `posts` WHERE `posts`.`user_id` = `users`.`id`) `matching`"
    },
    driverRows: [{ email: "a@b.c", title: "Hello" }],
    assertResult: [{ email: "a@b.c", title: "Hello" }]
  }),
  defineSqlFeatureSuite({
    id: "insert.onConflict",
    level: 7,
    requires: ["insert.onConflict"],
    build: ({ users }) => db.insert(users)
      .values({ email: "a@b.c", name: "A" })
      .onConflictDoUpdate([users.email], { name: excluded(users.name) }),
    assertSql: {
      postgres: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"',
      sqlite: 'INSERT INTO "users" ("email", "name") VALUES (?, ?) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"'
    },
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  }),
  defineSqlFeatureSuite({
    id: "insert.onDuplicateKey",
    level: 7,
    requires: ["insert.onDuplicateKey"],
    build: ({ users }) => db.insert(users)
      .values({ email: "a@b.c", name: "A" })
      .onDuplicateKeyUpdate({ name: excluded(users.name) }),
    assertSql: {
      mysql: "INSERT INTO `users` (`email`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)"
    },
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  })
]

/** Level 9 routine features: scalar, aggregate, window, table, and procedure calls. */
export const ROUTINE_SQL_FEATURES: ReadonlyArray<SqlFeature> = [
  defineSqlFeatureSuite({
    id: "routine.scalar",
    level: 9,
    requires: ["routine.functionCall"],
    build: ({ users }) => db.select({ lowered: lowerRoutine(users.email) }).from(users),
    assertSql: {
      postgres: 'SELECT "lower"("users"."email") AS "lowered" FROM "users"',
      mysql: "SELECT `lower`(`users`.`email`) AS `lowered` FROM `users`"
    },
    driverRows: [{ lowered: "a@b.c" }],
    assertResult: [{ lowered: "a@b.c" }]
  }),
  defineSqlFeatureSuite({
    id: "routine.aggregate",
    level: 9,
    requires: ["routine.functionCall"],
    build: ({ users }) => db.select({ total: sumRoutine(users.age) }).from(users),
    assertSql: {
      postgres: 'SELECT "sum"("users"."age") AS "total" FROM "users"',
      mysql: "SELECT `sum`(`users`.`age`) AS `total` FROM `users`"
    },
    driverRows: [{ total: 30 }],
    assertResult: [{ total: 30 }]
  }),
  defineSqlFeatureSuite({
    id: "routine.window",
    level: 9,
    requires: ["select.windowFunctions"],
    build: ({ users }) => db.select({ row: rowNumber().over({ orderBy: [asc(users.id)] }) }).from(users),
    assertSql: {
      postgres: 'SELECT ROW_NUMBER() OVER (ORDER BY "users"."id" ASC) AS "row" FROM "users"',
      sqlite: 'SELECT ROW_NUMBER() OVER (ORDER BY "users"."id" ASC) AS "row" FROM "users"',
      mysql: "SELECT ROW_NUMBER() OVER (ORDER BY `users`.`id` ASC) AS `row` FROM `users`"
    },
    driverRows: [{ row: 1 }],
    assertResult: [{ row: 1 }]
  }),
  defineSqlFeatureSuite({
    id: "routine.tableValued",
    level: 9,
    requires: ["routine.tableValuedFunction"],
    build: () => {
      const series = seriesRoutine.call({ start: 1, stop: 3 }, "series")
      return db.select({ value: series.field("value") }).from(series)
    },
    assertSql: {
      postgres: 'SELECT "series"."value" AS "value" FROM "generate_series"($1, $2) "series"("value")'
    },
    driverRows: [{ value: 1 }],
    assertResult: [{ value: 1 }]
  }),
  defineSqlFeatureSuite({
    id: "routine.procedure",
    level: 9,
    requires: ["routine.procedureCall"],
    build: () => cleanupRoutine.call({ before: "2026-01-01" }),
    assertSql: {
      postgres: 'CALL "maintenance"."cleanup"($1)',
      mysql: "CALL `maintenance`.`cleanup`(?)"
    },
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  })
]
