import { describe, expect, it } from "vitest"
import { count, db, eq, pg, sql } from "@gilvandovieira/thor"
import { PostgresCapabilities, defineCapabilities } from "@gilvandovieira/thor/capabilities"
import { expectGuardViolations } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").notNull()
})

describe("query guards (spec §8.1)", () => {
  it("accepts a well-scoped query supported by the dialect", () => {
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, "a@example.com"))

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toEqual([])
  })

  it("reports the exact out-of-scope column and active scope", () => {
    const query = db.select({ id: users.id }).from(users).where(eq(posts.id, users.id))

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toEqual([
      expect.objectContaining({
        _tag: "GuardError",
        guard: "table-scope",
        message: 'Column "posts"."id" is not in query scope {users}'
      })
    ])
  })

  it("finds out-of-scope columns interpolated into raw expressions", () => {
    const query = db.select({ id: users.id }).from(users).where(sql`${posts.id} IS NOT NULL`)

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toContainEqual(
      expect.objectContaining({
        _tag: "GuardError",
        guard: "table-scope",
        message: 'Column "posts"."id" is not in query scope {users}'
      })
    )
  })

  it("finds ungrouped columns interpolated into raw aggregate-scope expressions", () => {
    const query = db.select({ total: count() }).from(users).having(sql`${users.email} IS NOT NULL`)

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toContainEqual(
      expect.objectContaining({
        _tag: "GuardError",
        guard: "aggregation-scope",
        message: 'Column "users"."email" must appear in groupBy or an aggregate'
      })
    )
  })

  it("recognizes raw-expression column interpolations in groupBy", () => {
    const query = db.select({ email: users.email, total: count() }).from(users)
    const ir = { ...query.ir, groupBy: [sql`${users.email}`] }

    expect(expectGuardViolations(ir, PostgresCapabilities)).toEqual([])
  })

  it("checks returning selections for table scope", () => {
    const query = db.insert(users).values({ id: "u1", email: "a@example.com" }).returning({ postId: posts.id })

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toEqual([
      expect.objectContaining({
        _tag: "GuardError",
        guard: "table-scope",
        message: 'Column "posts"."id" is not in query scope {users}'
      })
    ])
  })

  it("rejects an insert with no columns at construction", () => {
    expect(() =>
      db
        .insert(users)
        .values({} as { id: string; email: string })
        .returning({ id: users.id })
    ).toThrow(
      expect.objectContaining({
        _tag: "ParameterError",
        parameter: "values"
      })
    )
  })

  it("rejects an insert with no rows at construction", () => {
    expect(() => db.insert(users).values([] as Array<{ id: string; email: string }>)).toThrow(
      expect.objectContaining({
        _tag: "ParameterError",
        parameter: "values"
      })
    )
  })

  it("rejects insert rows whose values do not match the first row's columns at construction", () => {
    expect(() =>
      db
        .insert(users)
        .values([{ id: "u1", email: "a@example.com" }, { id: "u2" } as { id: string; email: string }])
        .returning({ id: users.id })
    ).toThrow(
      expect.objectContaining({
        _tag: "ParameterError",
        reason: "missing",
        parameter: "email"
      })
    )
  })

  it("rejects an empty update SET built through the public query API", () => {
    const query = db.update(users).set({}).returning({ id: users.id })

    expect(expectGuardViolations(query.ir, PostgresCapabilities)).toContainEqual(
      expect.objectContaining({
        _tag: "GuardError",
        guard: "update-shape",
        message: "Update has an empty SET clause"
      })
    )
  })

  it("reports the missing returning capability with dialect context", () => {
    const capabilities = defineCapabilities("toydb", { "insert.returning": "unsupported" })
    const query = db.insert(users).values({ id: "u1", email: "a@example.com" }).returning({ id: users.id })

    expect(expectGuardViolations(query.ir, capabilities)).toContainEqual(
      expect.objectContaining({
        _tag: "CapabilityError",
        capability: "insert.returning",
        dialect: "toydb"
      })
    )
  })

  it("allows an emulated capability only when explicitly enabled", () => {
    const capabilities = defineCapabilities("toydb", { "update.returning": "emulated" })
    const query = db.update(users).set({ email: "new@example.com" }).returning({ id: users.id })

    expect(expectGuardViolations(query.ir, capabilities, false)).toContainEqual(
      expect.objectContaining({ _tag: "CapabilityError", capability: "update.returning" })
    )
    expect(expectGuardViolations(query.ir, capabilities, true)).toEqual([])
  })
})
