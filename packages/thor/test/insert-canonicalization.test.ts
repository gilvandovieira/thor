import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { db, param, pg } from "@gilvandovieira/thor"
import { Schema } from "effect"
import { expectSql } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable()
})

/**
 * P0.1 — multi-row inserts must derive one canonical physical column list and
 * project every row into it by application key, never by JS property order.
 */
describe("multi-row insert canonicalization (P0.1)", () => {
  it("binds values by key regardless of property order in later rows", () => {
    const query = db
      .insert(users)
      .values([
        { email: "a@example.com", name: "Ada" },
        { name: "Grace", email: "g@example.com" }
      ])
      .returning({ id: users.id })

    const compiled = expectSql(query)
    expect(compiled.sql).toContain('INSERT INTO "users" ("email", "name")')
    expect(compiled.params).toEqual([
      expect.objectContaining({ name: "users.email", value: "a@example.com" }),
      expect.objectContaining({ name: "users.name", value: "Ada" }),
      // Second row keyed in reverse order must still bind email then name.
      expect.objectContaining({ name: "users.email", value: "g@example.com" }),
      expect.objectContaining({ name: "users.name", value: "Grace" })
    ])
  })

  it("keeps three+ rows aligned under randomized property ordering", () => {
    const query = db.insert(users).values([
      { email: "a@x.com", name: "A", age: 1 },
      { age: 2, name: "B", email: "b@x.com" },
      { name: "C", email: "c@x.com", age: 3 }
    ])

    const compiled = expectSql(query)
    expect(compiled.sql).toContain('("email", "name", "age")')
    expect(compiled.params.map((p) => p.value)).toEqual(["a@x.com", "A", 1, "b@x.com", "B", 2, "c@x.com", "C", 3])
  })

  it("rejects a later row missing a required column", () => {
    expect(() =>
      db
        .insert(users)
        .values([{ email: "a@x.com", name: "A" }, { email: "b@x.com" } as { email: string; name: string }])
    ).toThrow(expect.objectContaining({ _tag: "ParameterError", reason: "missing", parameter: "name" }))
  })

  it("rejects a later row with an additional column", () => {
    expect(() =>
      db.insert(users).values([
        { email: "a@x.com", name: "A" },
        { email: "b@x.com", name: "B", age: 5 }
      ])
    ).toThrow(expect.objectContaining({ _tag: "ParameterError", reason: "extra", parameter: "age" }))
  })

  it("rejects unknown runtime keys introduced through a cast", () => {
    expect(() =>
      db.insert(users).values({ email: "a@x.com", name: "A", nope: 1 } as unknown as { email: string; name: string })
    ).toThrow(expect.objectContaining({ _tag: "ParameterError", reason: "extra", parameter: "nope" }))
  })

  it("keeps named parameters and inline values aligned to their columns", () => {
    const query = db.insert(users).values([
      { name: param("n", Schema.String), email: "a@x.com" },
      { email: "b@x.com", name: param("n2", Schema.String) }
    ])

    const compiled = expectSql(query)
    expect(compiled.sql).toContain('("name", "email")')
    // Canonical order (name, email) from row 0; row 1 is keyed in reverse but realigns.
    expect(compiled.params[0]).toMatchObject({ name: "n" })
    expect(compiled.params[1]).toMatchObject({ name: "users.email", value: "a@x.com" })
    expect(compiled.params[2]).toMatchObject({ name: "n2" })
    expect(compiled.params[3]).toMatchObject({ name: "users.email", value: "b@x.com" })
  })

  it("property: permuting key order never changes column→value binding", () => {
    const arb = fc.record({
      email: fc.string(),
      name: fc.string(),
      age: fc.integer()
    })
    fc.assert(
      fc.property(arb, arb, (r1, r2) => {
        // Reference: first row fixes canonical order (email, name, age).
        const baseline = db.insert(users).values([
          { email: r1.email, name: r1.name, age: r1.age },
          { email: r2.email, name: r2.name, age: r2.age }
        ])
        const permuted = db.insert(users).values([
          { email: r1.email, name: r1.name, age: r1.age },
          // deliberately reordered keys, same semantic content
          { age: r2.age, email: r2.email, name: r2.name }
        ])
        const a = expectSql(baseline).params.map((p) => p.value)
        const b = expectSql(permuted).params.map((p) => p.value)
        expect(b).toEqual(a)
      })
    )
  })
})
