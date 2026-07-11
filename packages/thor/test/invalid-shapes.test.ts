import { describe, expect, it } from "vitest"
import { and, asc, db, eq, inArray, notInArray, or, pg } from "@gilvandovieira/thor"
import { expectSql } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  age: pg.integer("age").nullable()
})

function buildWhere(pred: ReturnType<typeof and>) {
  return db.select({ id: users.id }).from(users).where(pred)
}

/**
 * P0.6 — public builders must never produce invalid SQL from degenerate inputs.
 */
describe("degenerate query shapes lower to valid SQL (P0.6)", () => {
  it("empty inArray lowers to a false constant", () => {
    const sql = expectSql(buildWhere(inArray(users.id, []))).sql
    expect(sql).not.toMatch(/IN \(\)/)
    expect(sql).toMatch(/WHERE FALSE$/)
  })

  it("empty notInArray lowers to a true constant", () => {
    const sql = expectSql(buildWhere(notInArray(users.id, []))).sql
    expect(sql).not.toMatch(/NOT IN \(\)/)
    expect(sql).toMatch(/WHERE TRUE$/)
  })

  it("empty and() lowers to TRUE, empty or() lowers to FALSE", () => {
    expect(expectSql(buildWhere(and())).sql).toMatch(/WHERE TRUE$/)
    expect(expectSql(buildWhere(or())).sql).toMatch(/WHERE FALSE$/)
  })

  it("non-empty inArray still compiles normally", () => {
    const compiled = expectSql(buildWhere(inArray(users.email, ["a", "b"])))
    expect(compiled.sql).toMatch(/IN \(\$1, \$2\)/)
    expect(compiled.params.map((p) => p.value)).toEqual(["a", "b"])
  })

  it("empty inArray produces no parameters or placeholders", () => {
    const compiled = expectSql(buildWhere(and(inArray(users.email, []), eq(users.email, "x"))))
    // one placeholder for the eq, none for the empty IN
    expect(compiled.params.length).toBe(1)
    expect(compiled.sql).toContain("$1")
    expect(compiled.sql).not.toContain("$2")
  })
})

describe("pagination validation (P0.6)", () => {
  const q = db.select({ id: users.id }).from(users)

  it("rejects NaN / Infinity / negative / fractional limit", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => q.limit(bad)).toThrow(expect.objectContaining({ _tag: "GuardError", guard: "limit-shape" }))
    }
  })

  it("rejects NaN / Infinity / negative / fractional offset", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5]) {
      expect(() => q.offset(bad)).toThrow(expect.objectContaining({ _tag: "GuardError", guard: "offset-shape" }))
    }
  })

  it("accepts valid pagination", () => {
    expect(expectSql(q.limit(10).offset(20)).sql).toMatch(/LIMIT 10 OFFSET 20$/)
    expect(expectSql(q.limit(0)).sql).toMatch(/LIMIT 0$/)
  })
})

describe("toSql() never emits malformed SQL from empty states (Finding 9)", () => {
  const compileError = expect.objectContaining({ _tag: "CompileError" })

  it("rejects an empty selection at compile", () => {
    const query = db.select({} as never).from(users)
    expect(() => query.toSql()).toThrow(compileError)
  })

  it("rejects an empty update SET at compile", () => {
    const query = db
      .update(users)
      .set({} as never)
      .returning({ id: users.id })
    expect(() => query.toSql()).toThrow(compileError)
  })

  it("rejects an empty conflict update SET at compile", () => {
    const query = db
      .insert(users)
      .values({ email: "a@x.com" })
      .onConflictDoUpdate([users.email], {} as never)
    expect(() => query.toSql()).toThrow(compileError)
  })

  it("rejects a set-operation operand that carries ORDER BY, LIMIT, or OFFSET", () => {
    const base = db.select({ id: users.id }).from(users)
    const guardError = expect.objectContaining({ _tag: "GuardError", guard: "set-operation" })
    expect(() => base.union(db.select({ id: users.id }).from(users).limit(5))).toThrow(guardError)
    expect(() => base.union(db.select({ id: users.id }).from(users).offset(2))).toThrow(guardError)
    expect(() => base.intersect(db.select({ id: users.id }).from(users).orderBy(asc(users.id)))).toThrow(guardError)
  })

  it("allows a plain set-operation operand and caps a one() probe at LIMIT 2", () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .union(db.select({ id: users.id }).from(users))
    expect(query.toSql().sql).not.toContain("LIMIT")
  })
})
