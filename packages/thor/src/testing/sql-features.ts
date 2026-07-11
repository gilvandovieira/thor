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
import { Cause, Effect, Either, Exit, type Layer, Option, Schema } from "effect"
import { db } from "../sql/query-builder.js"
import { and, eq, gt, isNull, not, or } from "../sql/predicates.js"
import { asc, desc, param } from "../sql/expressions.js"
import { avg, count, excluded, exists, max, min, rowNumber, scalar, sum } from "../sql/advanced-expressions.js"
import { alias, defineTable } from "../schema/table.js"
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  real,
  SafeIntegerCodec,
  text,
  timestamp,
  uuid
} from "../schema/index.js"
import type { Capability } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import type { Dialect } from "../dialect.js"
import { CapabilityError, TransactionError } from "../errors/index.js"
import type { CompiledStatement, RawRow } from "../execution/driver.js"
import { Database } from "../execution/database.js"
import { isInTransaction } from "../execution/transaction.js"
import type { QueryArgs } from "../execution/run.js"
import { checksum, compileOperation, defineMigration, guardOperations, sql, tableToCreateOp } from "../migrate/index.js"
import type { MigrationOperation } from "../migrate/index.js"
import { detectDrift } from "../introspect/index.js"
import { defineAggregateFunction, defineFunction, defineProcedure, defineTableFunction } from "../routine/index.js"
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
/** Fixture exercising Level 6 data types across dialect-independent codecs. */
const typed = defineTable("typed", {
  id: uuid("id").primaryKey(),
  active: boolean("active").notNull(),
  score: bigint("score").notNull(),
  ratio: real("ratio").notNull(),
  at: timestamp("at").notNull(),
  on: date("on").notNull(),
  meta: jsonb("meta", Schema.Struct({ role: Schema.String })).notNull()
})
/** Shared schema fixtures passed to every SQL feature definition. */
export const sqlFeatureFixtures = { users, posts, typed } as const

/** Type of the shared schema fixtures passed to SQL feature builders. */
export type SqlFeatureFixtures = typeof sqlFeatureFixtures

/** How a feature is executed against the driver. */
export type FeatureExec = "all" | "one" | "maybeOne" | "run"

/** One executable SQL feature definition (spec §14.11). */
export interface QuerySqlFeature {
  readonly kind?: never
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

/** Non-query scenario executed by the same feature-matrix runner. */
export interface ScenarioSqlFeature {
  readonly kind: "scenario"
  /** Stable feature identifier used in generated test names. */
  readonly id: string
  /** SQL feature-matrix level from the specification. */
  readonly level: number
  /** Capabilities that must be available before execution. */
  readonly requires: ReadonlyArray<Capability>
  /**
   * @param dialect - Dialect under test.
   * @returns A transaction, DDL compiler, migration guard, or drift scenario.
   */
  readonly execute: (dialect: Dialect) => Effect.Effect<unknown, unknown, Database>
  /** Expected scenario result when it is independent of the dialect. */
  readonly assertResult?: unknown
  /** Expected scenario result keyed by dialect id. */
  readonly assertResultByDialect?: Readonly<Record<string, unknown>>
  /** Expected fake-driver SQL calls keyed by dialect id. */
  readonly assertCalls?: Readonly<Record<string, ReadonlyArray<string>>>
}

/** One executable SQL feature definition (spec §14.11). */
export type SqlFeature = QuerySqlFeature | ScenarioSqlFeature

/**
 * Identity helper documenting a feature definition.
 *
 * @param feature - Executable SQL feature definition.
 * @returns The same feature definition with its type checked.
 */
export const defineSqlFeatureSuite = (feature: SqlFeature): SqlFeature => feature

/** @param feature - Feature to inspect. @returns Whether it uses the scenario runner. */
const isScenarioFeature = (feature: SqlFeature): feature is ScenarioSqlFeature => feature.kind === "scenario"

interface RunnableQuery {
  /**
   * @param dialect - Target SQL dialect.
   * @returns Compiled SQL and parameter metadata.
   */
  readonly toSql?: (dialect: Dialect) => CompiledStatement
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
  /** Whether emulated capabilities may satisfy feature requirements. */
  readonly allowEmulation?: boolean
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
      const supported = feature.requires.every((capability) =>
        isSatisfied(dialect.capabilities, capability, options.allowEmulation ?? false)
      )

      describe(`L${feature.level} ${feature.id}`, () => {
        if (!isScenarioFeature(feature) && feature.assertSql[dialect.id] !== undefined) {
          it("compiles to the expected SQL", () => {
            const q = feature.build(sqlFeatureFixtures) as RunnableQuery
            expect(q.toSql?.(dialect).sql).toBe(feature.assertSql[dialect.id])
          })
        }

        if (!isScenarioFeature(feature)) {
          it("declares its required capabilities", () => {
            const q = feature.build(sqlFeatureFixtures) as RunnableQuery
            expect(q.requiredCapabilities?.() ?? []).toEqual(feature.requires)
          })
        }

        if (supported) {
          it("executes and decodes against the fake driver", async () => {
            const driver = new FakeDriver()
            let effect: Effect.Effect<unknown, unknown, Database>
            if (isScenarioFeature(feature)) {
              effect = feature.execute(dialect)
            } else {
              if (feature.driverRows) driver.enqueue({ rows: feature.driverRows })
              else driver.enqueue({ rowCount: feature.driverRowCount ?? 0 })
              const q = feature.build(sqlFeatureFixtures) as RunnableQuery
              const method: FeatureExec = feature.exec ?? "all"
              effect = q[method]!(feature.args)
            }
            const result = await Effect.runPromise(
              Effect.provide(
                effect,
                FakeDatabaseLayer(driver, { dialect, allowEmulation: options.allowEmulation ?? false })
              )
            )
            const expected = isScenarioFeature(feature)
              ? (feature.assertResultByDialect?.[dialect.id] ?? feature.assertResult)
              : feature.assertResult
            expect(result).toEqual(expected)
            if (isScenarioFeature(feature) && feature.assertCalls?.[dialect.id]) {
              expect(driver.calls.map((call) => call.sql)).toEqual(feature.assertCalls[dialect.id])
            }
          })
        } else {
          it("fails with CapabilityError before the driver", async () => {
            const driver = new FakeDriver()
            const effect = isScenarioFeature(feature)
              ? feature.execute(dialect)
              : (() => {
                  const q = feature.build(sqlFeatureFixtures) as RunnableQuery
                  const method: FeatureExec = feature.exec ?? "all"
                  return q[method]!(feature.args)
                })()
            const error = await Effect.runPromise(
              Effect.flip(
                Effect.provide(
                  effect,
                  FakeDatabaseLayer(driver, { dialect, allowEmulation: options.allowEmulation ?? false })
                )
              )
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
  /** Whether the supplied layer enables emulated capabilities. */
  readonly allowEmulation?: boolean
  /** @returns Optional live-database setup completion. */
  readonly setup?: () => void | Promise<void>
  /** @returns Optional live-database teardown completion. */
  readonly teardown?: () => void | Promise<void>
}

/**
 * Runs the feature matrix against a **real** dialect (spec §14.11 integration
 * level): it proves the generated SQL is actually valid for that backend.
 *
 * Execution uses the default safe mode so live driver representations are
 * validated by the same decoder plan users receive. A supported feature must
 * not surface a query error; an unsupported feature must fail with
 * `CapabilityError` before the driver.
 *
 * @param api - Test-runner registration and assertion functions.
 * @param options - Dialect, features, live layer, and reset DDL.
 * @returns Nothing; tests are registered synchronously.
 */
export const runSqlFeatureIntegration = (api: ContractTestApi, options: SqlFeatureIntegrationOptions): void => {
  const { describe, it, beforeAll, afterAll, beforeEach, expect } = api
  const { dialect } = options
  const layer = options.layer
  const script = (sql: string): Promise<unknown> =>
    Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Database, (d) =>
          d.driver.executeScript ? d.driver.executeScript(sql) : d.driver.execute(sql, [])
        ),
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
      const supported = feature.requires.every((capability) =>
        isSatisfied(dialect.capabilities, capability, options.allowEmulation ?? false)
      )

      if (supported) {
        it(`L${feature.level} ${feature.id} runs valid SQL on ${dialect.id}`, async () => {
          const effect = isScenarioFeature(feature)
            ? feature.execute(dialect)
            : (() => {
                const q = feature.build(sqlFeatureFixtures) as RunnableQuery
                const method: FeatureExec = feature.exec ?? "all"
                return q[method]!(feature.args)
              })()
          const result = await Effect.runPromise(Effect.either(Effect.provide(effect, layer)))
          if (Either.isLeft(result)) {
            // Query cardinality/constraint errors mean SQL executed; scenarios must complete successfully.
            const tag = (result.left as { readonly _tag?: string })._tag
            if (
              isScenarioFeature(feature) ||
              (tag !== "ConstraintError" && tag !== "NotFoundError" && tag !== "TooManyRowsError")
            )
              throw result.left
          } else if (isScenarioFeature(feature)) {
            expect(result.right).toEqual(feature.assertResultByDialect?.[dialect.id] ?? feature.assertResult)
          }
        })
      } else {
        it(`L${feature.level} ${feature.id} rejects with CapabilityError on ${dialect.id}`, async () => {
          const effect = isScenarioFeature(feature)
            ? feature.execute(dialect)
            : (() => {
                const q = feature.build(sqlFeatureFixtures) as RunnableQuery
                const method: FeatureExec = feature.exec ?? "all"
                return q[method]!(feature.args)
              })()
          const error = await Effect.runPromise(Effect.flip(Effect.provide(effect, layer)))
          expect(error).toBeInstanceOf(CapabilityError)
        })
      }
    }
  })
}

const emailParam = param("email", Schema.String)
const textArg = { dataType: "text" as const, codec: Schema.String }
const integerArg = { dataType: "integer" as const, codec: SafeIntegerCodec }
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
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, emailParam), or(gt(users.age, 18), isNull(users.age)))),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = $1 AND ("users"."age" > $2 OR "users"."age" IS NULL))',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."email" = ? AND ("users"."age" > ? OR "users"."age" IS NULL))',
      mysql:
        "SELECT `users`.`id` AS `id` FROM `users` WHERE (`users`.`email` = ? AND (`users`.`age` > ? OR `users`.`age` IS NULL))"
    },
    exec: "all",
    args: { email: "a@b.c" },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.where.not",
    level: 1,
    requires: [],
    build: ({ users }) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(not(eq(users.email, emailParam))),
    assertSql: {
      postgres: 'SELECT "users"."id" AS "id" FROM "users" WHERE NOT ("users"."email" = $1)',
      sqlite: 'SELECT "users"."id" AS "id" FROM "users" WHERE NOT ("users"."email" = ?)',
      mysql: "SELECT `users`.`id` AS `id` FROM `users` WHERE NOT (`users`.`email` = ?)"
    },
    args: { email: "blocked@x.c" },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.orderLimitOffset",
    level: 1,
    requires: [],
    build: ({ users }) =>
      db.select({ id: users.id }).from(users).orderBy(desc(users.age), asc(users.id)).limit(10).offset(5),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" ORDER BY "users"."age" DESC, "users"."id" ASC LIMIT 10 OFFSET 5',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" ORDER BY "users"."age" DESC, "users"."id" ASC LIMIT 10 OFFSET 5',
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
    assertSql: {
      postgres: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2)',
      sqlite: 'INSERT INTO "users" ("email", "name") VALUES (?, ?)',
      mysql: "INSERT INTO `users` (`email`, `name`) VALUES (?, ?)"
    },
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  }),
  defineSqlFeatureSuite({
    id: "insert.many",
    level: 1,
    requires: [],
    build: ({ users }) =>
      db.insert(users).values([
        { email: "a@b.c", name: "A" },
        { email: "b@b.c", name: "B" }
      ]),
    assertSql: {
      postgres: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2), ($3, $4)',
      sqlite: 'INSERT INTO "users" ("email", "name") VALUES (?, ?), (?, ?)',
      mysql: "INSERT INTO `users` (`email`, `name`) VALUES (?, ?), (?, ?)"
    },
    exec: "run",
    driverRowCount: 2,
    assertResult: { rowCount: 2 }
  }),
  defineSqlFeatureSuite({
    id: "update.where",
    level: 1,
    requires: [],
    build: ({ users }) => db.update(users).set({ name: "N" }).where(eq(users.email, emailParam)),
    assertSql: {
      postgres: 'UPDATE "users" SET "name" = $1 WHERE "users"."email" = $2',
      sqlite: 'UPDATE "users" SET "name" = ? WHERE "users"."email" = ?',
      mysql: "UPDATE `users` SET `name` = ? WHERE `users`.`email` = ?"
    },
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
    assertSql: {
      postgres: 'DELETE FROM "users" WHERE "users"."email" = $1',
      sqlite: 'DELETE FROM "users" WHERE "users"."email" = ?',
      mysql: "DELETE FROM `users` WHERE `users`.`email` = ?"
    },
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
    build: ({ users }) =>
      db.update(users).set({ name: "N" }).where(eq(users.email, emailParam)).returning({ id: users.id }),
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
/**
 * Level 6 (data types): each dialect-independent codec decodes its driver
 * representations back to the runtime type. Column type appears only in DDL, so
 * the SELECT SQL is dialect-neutral; the interesting axis is decode.
 */
export const DATA_TYPE_FEATURES: ReadonlyArray<SqlFeature> = [
  defineSqlFeatureSuite({
    id: "datatype.uuid",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ id: typed.id }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."id" AS "id" FROM "typed"',
      sqlite: 'SELECT "typed"."id" AS "id" FROM "typed"',
      mysql: "SELECT `typed`.`id` AS `id` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ id: "550e8400-e29b-41d4-a716-446655440000" }],
    assertResult: [{ id: "550e8400-e29b-41d4-a716-446655440000" }]
  }),
  defineSqlFeatureSuite({
    id: "datatype.boolean",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ active: typed.active }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."active" AS "active" FROM "typed"',
      sqlite: 'SELECT "typed"."active" AS "active" FROM "typed"',
      mysql: "SELECT `typed`.`active` AS `active` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ active: 1 }], // SQLite's 0/1; the codec also accepts native booleans
    assertResult: [{ active: true }]
  }),
  defineSqlFeatureSuite({
    id: "datatype.bigint",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ score: typed.score }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."score" AS "score" FROM "typed"',
      sqlite: 'SELECT "typed"."score" AS "score" FROM "typed"',
      mysql: "SELECT `typed`.`score` AS `score` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ score: "9007199254740993" }], // beyond MAX_SAFE_INTEGER: decoded losslessly
    assertResult: [{ score: 9007199254740993n }]
  }),
  defineSqlFeatureSuite({
    id: "datatype.real",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ ratio: typed.ratio }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."ratio" AS "ratio" FROM "typed"',
      sqlite: 'SELECT "typed"."ratio" AS "ratio" FROM "typed"',
      mysql: "SELECT `typed`.`ratio` AS `ratio` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ ratio: "1.5" }], // decimal text from the driver
    assertResult: [{ ratio: 1.5 }]
  }),
  defineSqlFeatureSuite({
    id: "datatype.timestamp",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ at: typed.at }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."at" AS "at" FROM "typed"',
      sqlite: 'SELECT "typed"."at" AS "at" FROM "typed"',
      mysql: "SELECT `typed`.`at` AS `at` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ at: "2026-01-01T00:00:00.000Z" }], // ISO string decoded to Date
    assertResult: [{ at: new Date("2026-01-01T00:00:00.000Z") }]
  }),
  defineSqlFeatureSuite({
    id: "datatype.date",
    level: 6,
    requires: [],
    build: ({ typed }) => db.select({ on: typed.on }).from(typed),
    assertSql: {
      postgres: 'SELECT "typed"."on" AS "on" FROM "typed"',
      sqlite: 'SELECT "typed"."on" AS "on" FROM "typed"',
      mysql: "SELECT `typed`.`on` AS `on` FROM `typed`"
    },
    exec: "all",
    driverRows: [{ on: "2026-07-10" }],
    assertResult: [{ on: new Date("2026-07-10") }]
  })
  // NOTE: a `json`/`jsonb` feature is intentionally omitted here. PostgreSQL
  // returns JSON as a parsed value, but SQLite/MySQL return it as text and the
  // current json codec does not parse text — cross-dialect JSON decoding is a
  // tracked follow-up (its own codec change), not a feature-matrix gap.
]

/** @param postgres - PostgreSQL calls. @param sqlite - SQLite calls. @param mysql - MySQL calls. @returns Calls keyed by dialect. */
const transactionCalls = (
  postgres: ReadonlyArray<string>,
  sqlite: ReadonlyArray<string> = postgres,
  mysql: ReadonlyArray<string> = postgres
): Readonly<Record<string, ReadonlyArray<string>>> => ({ postgres, sqlite, mysql })

/** @param body - Transaction body. @returns The body inside a transaction boundary. */
const executeInTransaction = (body: Effect.Effect<unknown, unknown, Database> = Effect.void) => db.transaction(body)

const ddlParent = defineTable("feature_parents", {
  id: uuid("id").primaryKey()
})
const ddlChild = defineTable(
  "feature_children",
  {
    id: uuid("id").primaryKey(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => ddlParent.id, { onDelete: "cascade" })
  },
  { indexes: [{ name: "feature_children_parent_idx", columns: ["parentId"] }] }
)
const safeOperation = { destructive: false, reversible: true, capabilities: [] } as const
const addColumnOperation: MigrationOperation = {
  _tag: "AddColumn",
  table: "feature_children",
  column: { name: "label", type: "text", nullable: true },
  ...safeOperation
}
const dropColumnOperation: MigrationOperation = {
  _tag: "DropColumn",
  table: "feature_children",
  column: "label",
  destructive: true,
  reversible: false,
  capabilities: []
}

/** Levels 8 and 10: transaction lifecycle and migration/DDL scenarios. */
export const TRANSACTION_DDL_FEATURES: ReadonlyArray<SqlFeature> = [
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.commit",
    level: 8,
    requires: [],
    execute: () => executeInTransaction(Effect.succeed("committed")),
    assertResult: "committed",
    assertCalls: transactionCalls(["begin", "commit"], ["begin immediate", "commit"], ["start transaction", "commit"])
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.rollback.failure",
    level: 8,
    requires: [],
    execute: () =>
      Effect.map(
        Effect.exit(executeInTransaction(Effect.fail("failed"))),
        (exit) =>
          Exit.isFailure(exit) &&
          !Array.from(Cause.failures(exit.cause)).some((error) => error instanceof TransactionError)
      ),
    assertResult: true,
    assertCalls: transactionCalls(
      ["begin", "rollback"],
      ["begin immediate", "rollback"],
      ["start transaction", "rollback"]
    )
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.rollback.interruption",
    level: 8,
    requires: [],
    execute: () =>
      Effect.map(
        Effect.exit(executeInTransaction(Effect.interrupt)),
        (exit) =>
          Exit.isFailure(exit) &&
          !Array.from(Cause.failures(exit.cause)).some((error) => error instanceof TransactionError)
      ),
    assertResult: true,
    assertCalls: transactionCalls(
      ["begin", "rollback"],
      ["begin immediate", "rollback"],
      ["start transaction", "rollback"]
    )
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.nested.savepoint",
    level: 8,
    requires: ["transaction.savepoints"],
    execute: () => executeInTransaction(executeInTransaction()),
    assertResult: undefined,
    assertCalls: transactionCalls(
      ["begin", "savepoint thor_sp_1", "release savepoint thor_sp_1", "commit"],
      ["begin immediate", "savepoint thor_sp_1", "release savepoint thor_sp_1", "commit"],
      ["start transaction", "savepoint thor_sp_1", "release savepoint thor_sp_1", "commit"]
    )
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.isolation",
    level: 8,
    requires: ["transaction.isolationLevel"],
    execute: () => db.transaction(Effect.void, { isolationLevel: "serializable" }),
    assertResult: undefined,
    assertCalls: transactionCalls(
      ["begin isolation level SERIALIZABLE", "commit"],
      ["begin", "commit"],
      ["set transaction isolation level SERIALIZABLE", "start transaction", "commit"]
    )
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "transaction.scope.restored",
    level: 8,
    requires: [],
    execute: () =>
      Effect.gen(function* () {
        const inside = yield* db.transaction(Effect.map(Database, isInTransaction))
        const outside = yield* Effect.map(Database, isInTransaction)
        return { inside, outside }
      }),
    assertResult: { inside: true, outside: false },
    assertCalls: transactionCalls(["begin", "commit"], ["begin immediate", "commit"], ["start transaction", "commit"])
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "ddl.create.table-index-foreign-key",
    level: 10,
    requires: [],
    execute: (dialect) =>
      Effect.sync(() => {
        const ddl = compileOperation(tableToCreateOp(ddlChild), dialect)
        return {
          createsTable: ddl.includes("feature_children"),
          createsIndex: ddl.includes("feature_children_parent_idx"),
          createsForeignKey: ddl.includes("foreign key") && ddl.includes("feature_parents")
        }
      }),
    assertResult: { createsTable: true, createsIndex: true, createsForeignKey: true }
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "ddl.alter.add-drop-column",
    level: 10,
    requires: [],
    execute: (dialect) =>
      Effect.sync(() => [
        compileOperation(addColumnOperation, dialect),
        compileOperation(dropColumnOperation, dialect)
      ]),
    assertResultByDialect: {
      postgres: [
        'alter table "feature_children" add column "label" text;',
        'alter table "feature_children" drop column "label";'
      ],
      sqlite: [
        'alter table "feature_children" add column "label" text;',
        'alter table "feature_children" drop column "label";'
      ],
      mysql: [
        "alter table `feature_children` add column `label` text;",
        "alter table `feature_children` drop column `label`;"
      ]
    }
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "ddl.destructive.blocking",
    level: 10,
    requires: [],
    execute: () => Effect.sync(() => guardOperations([dropColumnOperation], "safe-only").map((error) => error.guard)),
    assertResult: ["destructive-migration"]
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "ddl.drift-detection",
    level: 10,
    requires: [],
    execute: () => Effect.sync(() => detectDrift([ddlParent], { tables: [] }).changes.map((change) => change._tag)),
    assertResult: ["MissingTable"]
  }),
  defineSqlFeatureSuite({
    kind: "scenario",
    id: "ddl.journal-checksum",
    level: 10,
    requires: [],
    execute: () =>
      Effect.sync(() => {
        const migration = defineMigration({
          id: "g6a-create-feature-table",
          name: "create feature table",
          up: sql`create table feature_table (id text primary key);`,
          down: sql`drop table feature_table;`
        })
        const first = checksum(migration)
        const second = checksum({ ...migration })
        const changed = checksum({ ...migration, down: sql`drop table feature_table cascade;` })
        return {
          deterministic: first === second,
          changesWithDefinition: first !== changed,
          format: /^sha256:v1:[0-9a-f]{64}$/.test(first)
        }
      }),
    assertResult: { deterministic: true, changesWithDefinition: true, format: true }
  })
]

/** Levels 3–5, 7, 9: joins, subqueries, aggregation, CTEs, window functions, upserts. */
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
      postgres:
        'SELECT "users"."email" AS "email", "p"."title" AS "title" FROM "users" INNER JOIN "posts" "p" ON "users"."id" = "p"."user_id"',
      sqlite:
        'SELECT "users"."email" AS "email", "p"."title" AS "title" FROM "users" INNER JOIN "posts" "p" ON "users"."id" = "p"."user_id"',
      mysql:
        "SELECT `users`.`email` AS `email`, `p`.`title` AS `title` FROM `users` INNER JOIN `posts` `p` ON `users`.`id` = `p`.`user_id`"
    },
    driverRows: [{ email: "a@b.c", title: "Hello" }],
    assertResult: [{ email: "a@b.c", title: "Hello" }]
  }),
  defineSqlFeatureSuite({
    id: "join.left",
    level: 3,
    requires: [],
    build: ({ users, posts }) =>
      db.select({ email: users.email, title: posts.title }).from(users).leftJoin(posts, eq(users.id, posts.userId)),
    assertSql: {
      postgres:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" LEFT JOIN "posts" ON "users"."id" = "posts"."user_id"',
      sqlite:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" LEFT JOIN "posts" ON "users"."id" = "posts"."user_id"',
      mysql:
        "SELECT `users`.`email` AS `email`, `posts`.`title` AS `title` FROM `users` LEFT JOIN `posts` ON `users`.`id` = `posts`.`user_id`"
    },
    driverRows: [{ email: "a@b.c", title: null }],
    assertResult: [{ email: "a@b.c", title: null }]
  }),
  defineSqlFeatureSuite({
    id: "join.right",
    level: 3,
    requires: ["select.rightJoin"],
    build: ({ users, posts }) =>
      db.select({ email: users.email, title: posts.title }).from(users).rightJoin(posts, eq(users.id, posts.userId)),
    assertSql: {
      postgres:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" RIGHT JOIN "posts" ON "users"."id" = "posts"."user_id"',
      sqlite:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" RIGHT JOIN "posts" ON "users"."id" = "posts"."user_id"',
      mysql:
        "SELECT `users`.`email` AS `email`, `posts`.`title` AS `title` FROM `users` RIGHT JOIN `posts` ON `users`.`id` = `posts`.`user_id`"
    },
    driverRows: [{ email: null, title: "Hello" }],
    assertResult: [{ email: null, title: "Hello" }]
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
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" WHERE EXISTS (SELECT "posts"."id" AS "id" FROM "posts" WHERE "posts"."user_id" = "users"."id")',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" WHERE EXISTS (SELECT "posts"."id" AS "id" FROM "posts" WHERE "posts"."user_id" = "users"."id")',
      mysql:
        "SELECT `users`.`id` AS `id` FROM `users` WHERE EXISTS (SELECT `posts`.`id` AS `id` FROM `posts` WHERE `posts`.`user_id` = `users`.`id`)"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "aggregate.group.having",
    level: 4,
    requires: [],
    build: ({ users }) =>
      db.select({ email: users.email, total: count() }).from(users).groupBy(users.email).having(gt(count(), 0)),
    assertSql: {
      postgres:
        'SELECT "users"."email" AS "email", COUNT(*) AS "total" FROM "users" GROUP BY "users"."email" HAVING COUNT(*) > $1',
      sqlite:
        'SELECT "users"."email" AS "email", COUNT(*) AS "total" FROM "users" GROUP BY "users"."email" HAVING COUNT(*) > ?',
      mysql:
        "SELECT `users`.`email` AS `email`, COUNT(*) AS `total` FROM `users` GROUP BY `users`.`email` HAVING COUNT(*) > ?"
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
      postgres:
        'WITH "active_users" AS (SELECT "users"."id" AS "id" FROM "users" WHERE "users"."age" > $1) SELECT "active_users"."id" AS "id" FROM "active_users"',
      sqlite:
        'WITH "active_users" AS (SELECT "users"."id" AS "id" FROM "users" WHERE "users"."age" > ?) SELECT "active_users"."id" AS "id" FROM "active_users"',
      mysql:
        "WITH `active_users` AS (SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`age` > ?) SELECT `active_users`.`id` AS `id` FROM `active_users`"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.window.rowNumber",
    level: 5,
    requires: ["select.windowFunctions"],
    build: ({ users }) =>
      db
        .select({
          id: users.id,
          row: rowNumber().over({ orderBy: [asc(users.createdAt)] })
        })
        .from(users),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id", ROW_NUMBER() OVER (ORDER BY "users"."created_at" ASC) AS "row" FROM "users"',
      sqlite:
        'SELECT "users"."id" AS "id", ROW_NUMBER() OVER (ORDER BY "users"."created_at" ASC) AS "row" FROM "users"',
      mysql: "SELECT `users`.`id` AS `id`, ROW_NUMBER() OVER (ORDER BY `users`.`created_at` ASC) AS `row` FROM `users`"
    },
    driverRows: [{ id: "u1", row: 1 }],
    assertResult: [{ id: "u1", row: 1 }]
  }),
  defineSqlFeatureSuite({
    id: "select.set.union",
    level: 5,
    requires: ["select.setOperations"],
    build: ({ users }) =>
      db
        .select({ id: users.id })
        .from(users)
        .union(db.select({ id: users.id }).from(users).where(isNull(users.name))),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" UNION SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" UNION SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      mysql:
        "SELECT `users`.`id` AS `id` FROM `users` UNION SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`name` IS NULL"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "join.full",
    level: 3,
    requires: ["select.fullJoin"],
    build: ({ users, posts }) =>
      db.select({ email: users.email, title: posts.title }).from(users).fullJoin(posts, eq(users.id, posts.userId)),
    assertSql: {
      postgres:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" FULL JOIN "posts" ON "users"."id" = "posts"."user_id"',
      sqlite:
        'SELECT "users"."email" AS "email", "posts"."title" AS "title" FROM "users" FULL JOIN "posts" ON "users"."id" = "posts"."user_id"'
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
      return db
        .select({ id: selected.field("id") })
        .from(selected)
        .where(eq(selected.field("id"), scalar(first)))
    },
    assertSql: {
      postgres:
        'SELECT "selected"."id" AS "id" FROM (SELECT "users"."id" AS "id" FROM "users") "selected" WHERE "selected"."id" = (SELECT "users"."id" AS "id" FROM "users" LIMIT 1)',
      sqlite:
        'SELECT "selected"."id" AS "id" FROM (SELECT "users"."id" AS "id" FROM "users") "selected" WHERE "selected"."id" = (SELECT "users"."id" AS "id" FROM "users" LIMIT 1)',
      mysql:
        "SELECT `selected`.`id` AS `id` FROM (SELECT `users`.`id` AS `id` FROM `users`) `selected` WHERE `selected`.`id` = (SELECT `users`.`id` AS `id` FROM `users` LIMIT 1)"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "aggregate.functions",
    level: 4,
    requires: [],
    build: ({ users }) =>
      db
        .select({
          count: count(users.id),
          sum: sum(users.age),
          avg: avg(users.age),
          min: min(users.age),
          max: max(users.age)
        })
        .from(users),
    assertSql: {
      postgres:
        'SELECT COUNT("users"."id") AS "count", SUM("users"."age") AS "sum", AVG("users"."age") AS "avg", MIN("users"."age") AS "min", MAX("users"."age") AS "max" FROM "users"',
      sqlite:
        'SELECT COUNT("users"."id") AS "count", SUM("users"."age") AS "sum", AVG("users"."age") AS "avg", MIN("users"."age") AS "min", MAX("users"."age") AS "max" FROM "users"',
      mysql:
        "SELECT COUNT(`users`.`id`) AS `count`, SUM(`users`.`age`) AS `sum`, AVG(`users`.`age`) AS `avg`, MIN(`users`.`age`) AS `min`, MAX(`users`.`age`) AS `max` FROM `users`"
    },
    driverRows: [{ count: 1, sum: 30, avg: 30, min: 30, max: 30 }],
    assertResult: [{ count: 1, sum: 30, avg: 30, min: 30, max: 30 }]
  }),
  defineSqlFeatureSuite({
    id: "select.distinct",
    level: 4,
    requires: [],
    build: ({ users }) => db.select({ name: users.name }).from(users).distinct(),
    assertSql: {
      postgres: 'SELECT DISTINCT "users"."name" AS "name" FROM "users"',
      sqlite: 'SELECT DISTINCT "users"."name" AS "name" FROM "users"',
      mysql: "SELECT DISTINCT `users`.`name` AS `name` FROM `users`"
    },
    driverRows: [{ name: "A" }],
    assertResult: [{ name: "A" }]
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
      postgres:
        'WITH RECURSIVE "selected_users" AS (SELECT "users"."id" AS "id" FROM "users") SELECT "selected_users"."id" AS "id" FROM "selected_users"',
      sqlite:
        'WITH RECURSIVE "selected_users" AS (SELECT "users"."id" AS "id" FROM "users") SELECT "selected_users"."id" AS "id" FROM "selected_users"',
      mysql:
        "WITH RECURSIVE `selected_users` AS (SELECT `users`.`id` AS `id` FROM `users`) SELECT `selected_users`.`id` AS `id` FROM `selected_users`"
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
      return db
        .select({ email: users.email, title: matching.field("title") })
        .from(users)
        .lateralJoin(matching)
    },
    assertSql: {
      postgres:
        'SELECT "users"."email" AS "email", "matching"."title" AS "title" FROM "users" CROSS JOIN LATERAL (SELECT "posts"."title" AS "title" FROM "posts" WHERE "posts"."user_id" = "users"."id") "matching"',
      mysql:
        "SELECT `users`.`email` AS `email`, `matching`.`title` AS `title` FROM `users` CROSS JOIN LATERAL (SELECT `posts`.`title` AS `title` FROM `posts` WHERE `posts`.`user_id` = `users`.`id`) `matching`"
    },
    driverRows: [{ email: "a@b.c", title: "Hello" }],
    assertResult: [{ email: "a@b.c", title: "Hello" }]
  }),
  defineSqlFeatureSuite({
    id: "select.set.intersect",
    level: 5,
    requires: ["select.setOperations"],
    build: ({ users }) =>
      db
        .select({ id: users.id })
        .from(users)
        .intersect(db.select({ id: users.id }).from(users).where(isNull(users.name))),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" INTERSECT SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" INTERSECT SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      mysql:
        "SELECT `users`.`id` AS `id` FROM `users` INTERSECT SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`name` IS NULL"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "select.set.except",
    level: 5,
    requires: ["select.setOperations"],
    build: ({ users }) =>
      db
        .select({ id: users.id })
        .from(users)
        .except(db.select({ id: users.id }).from(users).where(isNull(users.name))),
    assertSql: {
      postgres:
        'SELECT "users"."id" AS "id" FROM "users" EXCEPT SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      sqlite:
        'SELECT "users"."id" AS "id" FROM "users" EXCEPT SELECT "users"."id" AS "id" FROM "users" WHERE "users"."name" IS NULL',
      mysql:
        "SELECT `users`.`id` AS `id` FROM `users` EXCEPT SELECT `users`.`id` AS `id` FROM `users` WHERE `users`.`name` IS NULL"
    },
    driverRows: [{ id: "u1" }],
    assertResult: [{ id: "u1" }]
  }),
  defineSqlFeatureSuite({
    id: "insert.onConflict",
    level: 7,
    requires: ["insert.onConflict"],
    build: ({ users }) =>
      db
        .insert(users)
        .values({ email: "a@b.c", name: "A" })
        .onConflictDoUpdate([users.email], { name: excluded(users.name) }),
    assertSql: {
      postgres:
        'INSERT INTO "users" ("email", "name") VALUES ($1, $2) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"',
      sqlite:
        'INSERT INTO "users" ("email", "name") VALUES (?, ?) ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"'
    },
    exec: "run",
    driverRowCount: 1,
    assertResult: { rowCount: 1 }
  }),
  defineSqlFeatureSuite({
    id: "insert.onDuplicateKey",
    level: 7,
    requires: ["insert.onDuplicateKey"],
    build: ({ users }) =>
      db
        .insert(users)
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
      postgres: 'SELECT "series"."value" AS "value" FROM "generate_series"($1::integer, $2::integer) "series"("value")'
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
