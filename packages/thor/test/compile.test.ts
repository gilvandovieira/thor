import { describe, expect, it } from "vitest"
import { and, asc, db, desc, eq, gt, inArray, isNull, not, or, param, pg } from "@gilvandovieira/thor"
import { Schema } from "effect"
import { expectSql } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable()
})

describe("Postgres compiler (spec Milestone 4)", () => {
  it("compiles every select clause and preserves named parameter metadata", () => {
    const query = db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
      .orderBy(desc(users.email), asc(users.id))
      .limit(10)
      .offset(20)

    const compiled = expectSql(query)

    expect(compiled).toMatchObject({
      sql: 'SELECT "users"."id" AS "id", "users"."email" AS "email" FROM "users" WHERE "users"."email" = $1 ORDER BY "users"."email" DESC, "users"."id" ASC LIMIT 10 OFFSET 20',
      params: [{ name: "email" }]
    })
    // dialect id : capability-profile hash : structural hash (spec §15.14)
    expect(compiled.cacheKey).toMatch(/^postgres:[0-9a-f]{8}:[0-9a-f]{8}$/)
  })

  it("compiles nested predicates and binds inline values in SQL order", () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.name, ["Ada", "Grace"]),
          or(gt(users.age, 18), isNull(users.age)),
          not(eq(users.email, "blocked@example.com"))
        )
      )

    expect(expectSql(query)).toMatchObject({
      sql: 'SELECT "users"."id" AS "id" FROM "users" WHERE ("users"."name" IN ($1, $2) AND ("users"."age" > $3 OR "users"."age" IS NULL) AND NOT ("users"."email" = $4))',
      params: [
        { name: expect.any(String), value: "Ada" },
        { name: expect.any(String), value: "Grace" },
        { name: expect.any(String), value: 18 },
        { name: expect.any(String), value: "blocked@example.com" }
      ]
    })
  })

  it("compiles a multi-row insert with returning and stable parameter order", () => {
    const query = db
      .insert(users)
      .values([
        { email: "a@example.com", name: "Ada" },
        { email: "g@example.com", name: "Grace" }
      ])
      .returning({ id: users.id, email: users.email })

    expect(expectSql(query)).toMatchObject({
      sql: 'INSERT INTO "users" ("email", "name") VALUES ($1, $2), ($3, $4) RETURNING "users"."id" AS "id", "users"."email" AS "email"',
      params: [
        { name: "users.email", value: "a@example.com" },
        { name: "users.name", value: "Ada" },
        { name: "users.email", value: "g@example.com" },
        { name: "users.name", value: "Grace" }
      ]
    })
    expect(query.requiredCapabilities()).toEqual(["insert.returning"])
  })

  it("compiles update assignments before where parameters", () => {
    const query = db
      .update(users)
      .set({ name: "New", age: 42 })
      .where(eq(users.id, param("id", Schema.String)))
      .returning({ id: users.id })

    expect(expectSql(query)).toMatchObject({
      sql: 'UPDATE "users" SET "name" = $1, "age" = $2 WHERE "users"."id" = $3 RETURNING "users"."id" AS "id"',
      params: [{ name: "users.name", value: "New" }, { name: "users.age", value: 42 }, { name: "id" }]
    })
    expect(query.requiredCapabilities()).toEqual(["update.returning"])
  })

  it("compiles delete with a named parameter and returning", () => {
    const query = db
      .delete(users)
      .where(eq(users.id, param("id", Schema.String)))
      .returning({ id: users.id })

    expect(expectSql(query)).toMatchObject({
      sql: 'DELETE FROM "users" WHERE "users"."id" = $1 RETURNING "users"."id" AS "id"',
      params: [{ name: "id" }]
    })
    expect(query.requiredCapabilities()).toEqual(["delete.returning"])
  })

  it("uses query structure, not bound values, for cache keys", () => {
    const compileByEmail = (email: string) =>
      db.select({ id: users.id }).from(users).where(eq(users.email, email)).toSql()

    const first = compileByEmail("a@example.com")
    const second = compileByEmail("b@example.com")
    const differentShape = db.select({ id: users.id }).from(users).where(eq(users.name, "Ada")).toSql()

    expect(first.cacheKey).toBe(second.cacheKey)
    expect(first.paramOrder[0]?.value).not.toBe(second.paramOrder[0]?.value)
    expect(first.cacheKey).not.toBe(differentShape.cacheKey)
  })
})
