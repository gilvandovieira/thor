import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  CapabilityError,
  GuardError,
  MySQLDialect,
  PostgresDialect,
  SQLiteDialect,
  alias,
  avg,
  count,
  db,
  eq,
  exists,
  excluded,
  gt,
  inSubquery,
  max,
  min,
  notExists,
  notInSubquery,
  pg,
  rowNumber,
  scalar,
  sum,
  asc
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  age: pg.integer("age").nullable()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  userId: pg.uuid("user_id").notNull(),
  title: pg.text("title").notNull()
})

describe("Epic J advanced query features", () => {
  it("compiles aliased self joins and every join kind", () => {
    const parent = alias(users, "parent")
    const child = alias(users, "child")
    const base = db.select({ parent: parent.id, child: child.id }).from(parent)

    expect(base.join(child, eq(parent.id, child.id)).toSql().sql).toContain(
      'FROM "users" "parent" INNER JOIN "users" "child" ON "parent"."id" = "child"."id"'
    )
    expect(base.leftJoin(child, eq(parent.id, child.id)).toSql().sql).toContain("LEFT JOIN")
    expect(base.rightJoin(child, eq(parent.id, child.id)).toSql().sql).toContain("RIGHT JOIN")
    expect(base.fullJoin(child, eq(parent.id, child.id)).toSql().sql).toContain("FULL JOIN")
  })

  it("rejects columns and join predicates outside visible scope", async () => {
    const query = db.select({ title: posts.title }).from(users)
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(query.all(), FakeDatabaseLayer(new FakeDriver())))
    )
    expect(error).toBeInstanceOf(GuardError)
    expect((error as GuardError).guard).toBe("table-scope")
  })

  it("supports derived tables, correlated exists, and in-subqueries", () => {
    const titles = db.select({ title: posts.title }).from(posts).as("post_titles")
    const derived = db.select({ title: titles.field("title") }).from(titles)
    expect(derived.toSql().sql).toBe(
      'SELECT "post_titles"."title" AS "title" FROM (SELECT "posts"."title" AS "title" FROM "posts") "post_titles"'
    )

    const matching = db.select({ id: posts.id }).from(posts).where(eq(posts.userId, users.id))
    expect(db.select({ id: users.id }).from(users).where(exists(matching)).toSql().sql).toContain(
      'WHERE EXISTS (SELECT "posts"."id" AS "id" FROM "posts" WHERE "posts"."user_id" = "users"."id")'
    )
    expect(db.select({ id: users.id }).from(users).where(inSubquery(users.id, matching)).toSql().sql).toContain(
      '"users"."id" IN (SELECT'
    )
    expect(db.select({ id: users.id }).from(users).where(notExists(matching)).toSql().sql).toContain("WHERE NOT EXISTS")
    expect(db.select({ id: users.id }).from(users).where(notInSubquery(users.id, matching)).toSql().sql).toContain("NOT IN")
    expect(db.select({ id: users.id }).from(users).where(eq(users.id, scalar(matching))).toSql().sql).toContain(
      '"users"."id" = (SELECT'
    )
  })

  it("allows correlation only for expression and lateral subqueries", async () => {
    const correlated = db.select({ id: posts.id }).from(posts).where(eq(posts.userId, users.id)).as("p")
    const invalid = db.select({ id: users.id }).from(users).join(correlated, eq(users.id, correlated.field("id")))
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(invalid.all(), FakeDatabaseLayer(new FakeDriver())))
    )
    expect(error).toBeInstanceOf(GuardError)

    const lateral = db.select({ id: users.id }).from(users).lateralJoin(correlated)
    expect(lateral.toSql().sql).toContain("CROSS JOIN LATERAL")
  })

  it("compiles aggregate, grouping, having, distinct, and windows", () => {
    const grouped = db.select({ email: users.email, total: count() })
      .from(users)
      .distinct()
      .groupBy(users.email)
      .having(gt(count(), 0))
    expect(grouped.toSql().sql).toBe(
      'SELECT DISTINCT "users"."email" AS "email", COUNT(*) AS "total" FROM "users" GROUP BY "users"."email" HAVING COUNT(*) > $1'
    )

    const windowed = db.select({
      id: users.id,
      row: rowNumber().over({ partitionBy: [users.email], orderBy: [asc(users.id)] })
    }).from(users)
    expect(windowed.requiredCapabilities()).toContain("select.windowFunctions")
    expect(windowed.toSql().sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "users"."email" ORDER BY "users"."id" ASC)'
    )

    const aggregates = db.select({
      sum: sum(users.age),
      avg: avg(users.age),
      min: min(users.age),
      max: max(users.age)
    }).from(users)
    expect(aggregates.toSql().sql).toContain(
      'SUM("users"."age") AS "sum", AVG("users"."age") AS "avg", MIN("users"."age") AS "min", MAX("users"."age") AS "max"'
    )
  })

  it("rejects non-aggregated selected columns missing from groupBy", async () => {
    const invalid = db.select({ email: users.email, total: count() }).from(users)
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(invalid.all(), FakeDatabaseLayer(new FakeDriver())))
    )
    expect(error).toBeInstanceOf(GuardError)
    expect((error as GuardError).guard).toBe("aggregation-scope")
  })

  it("compiles CTEs, recursive CTEs, and set operations", () => {
    const body = db.select({ id: users.id }).from(users)
    const cte = db.cte("selected_users", body)
    expect(db.select({ id: cte.field("id") }).from(cte).toSql().sql).toBe(
      'WITH "selected_users" AS (SELECT "users"."id" AS "id" FROM "users") SELECT "selected_users"."id" AS "id" FROM "selected_users"'
    )

    const recursive = db.recursiveCte("walk", body)
    const recursiveQuery = db.select({ id: recursive.field("id") }).from(recursive)
    expect(recursiveQuery.toSql().sql).toContain("WITH RECURSIVE")
    expect(recursiveQuery.requiredCapabilities()).toContain("select.recursiveCte")

    const rhs = db.select({ id: users.id }).from(users).where(gt(users.age, 18))
    expect(body.unionAll(rhs).toSql().sql).toContain("UNION ALL")
    expect(body.intersect(rhs).toSql().sql).toContain("INTERSECT")
    expect(body.except(rhs).toSql().sql).toContain("EXCEPT")
  })

  it("renders PostgreSQL/SQLite conflict and MySQL duplicate-key syntax", () => {
    const conflict = db.insert(users)
      .values({ email: "a@b.c" })
      .onConflictDoUpdate([users.email], { email: excluded(users.email) })
    expect(conflict.toSql(PostgresDialect).sql).toContain(
      'ON CONFLICT ("email") DO UPDATE SET "email" = EXCLUDED."email"'
    )
    expect(conflict.toSql(SQLiteDialect).sql).toContain(
      'ON CONFLICT ("email") DO UPDATE SET "email" = EXCLUDED."email"'
    )

    const duplicate = db.insert(users)
      .values({ email: "a@b.c" })
      .onDuplicateKeyUpdate({ email: excluded(users.email) })
    expect(duplicate.toSql(MySQLDialect).sql).toContain(
      "ON DUPLICATE KEY UPDATE `email` = VALUES(`email`)"
    )
  })

  it("rejects unsupported advanced capabilities before reaching drivers", async () => {
    const cases = [
      {
        query: db.select({ id: users.id }).from(users).fullJoin(posts, eq(users.id, posts.userId)).all(),
        dialect: MySQLDialect
      },
      {
        query: db.select({ id: users.id }).from(users)
          .lateralJoin(db.select({ id: posts.id }).from(posts).as("p"))
          .all(),
        dialect: SQLiteDialect
      },
      {
        query: db.insert(users).values({ email: "a@b.c" }).onConflictDoNothing([users.email]).run(),
        dialect: MySQLDialect
      },
      {
        query: db.insert(users).values({ email: "a@b.c" }).onDuplicateKeyUpdate({ email: "b@c.d" }).run(),
        dialect: PostgresDialect
      }
    ]

    for (const testCase of cases) {
      const driver = new FakeDriver()
      const error = await Effect.runPromise(
        Effect.flip(Effect.provide(testCase.query, FakeDatabaseLayer(driver, { dialect: testCase.dialect })))
      )
      expect(error).toBeInstanceOf(CapabilityError)
      expect(driver.calls).toEqual([])
    }
  })
})
