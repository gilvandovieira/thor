import { describe, expect, it } from "vitest"
import { db, pg, unsafeSql } from "@gilvandovieira/thor"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  name: pg.text("name").nullable(),
  slug: pg.text("slug").generatedAlwaysAs(unsafeSql("lower(email)"))
})

const unknownKey = expect.objectContaining({ _tag: "ParameterError", reason: "extra" })
const generatedKey = expect.objectContaining({ _tag: "ParameterError", reason: "invalid" })

/**
 * Findings 8 & 10 — update/upsert must not silently drop unknown keys, prototype
 * keys must not bypass the unknown-key check, and generated columns cannot be
 * assigned.
 */
describe("mutation input validation (Findings 8, 10)", () => {
  it("rejects unknown update keys instead of silently dropping them (Finding 8)", () => {
    expect(() => db.update(users).set({ nmae: "typo" } as never)).toThrow(unknownKey)
  })

  it("rejects an all-unknown update rather than emitting an empty SET (Finding 8)", () => {
    expect(() => db.update(users).set({ nope: 1, huh: 2 } as never)).toThrow(unknownKey)
  })

  it("rejects unknown conflict-update keys (Finding 8)", () => {
    expect(() =>
      db
        .insert(users)
        .values({ email: "a@x.com" })
        .onConflictDoUpdate([users.email], { bogus: "x" } as never)
    ).toThrow(unknownKey)
  })

  it("rejects a prototype key with a tagged error, not a TypeError (Finding 10)", () => {
    expect(() => db.insert(users).values({ constructor: "x", email: "a@x.com" } as never)).toThrow(unknownKey)
    expect(() => db.update(users).set({ constructor: "x" } as never)).toThrow(unknownKey)
  })

  it("rejects assigning a generated column in insert and update (Finding 10)", () => {
    expect(() => db.insert(users).values({ email: "a@x.com", slug: "x" } as never)).toThrow(generatedKey)
    expect(() => db.update(users).set({ slug: "x" } as never)).toThrow(generatedKey)
  })

  it("still accepts valid updates and upserts", () => {
    expect(() => db.update(users).set({ name: "New" })).not.toThrow()
    expect(() =>
      db.insert(users).values({ email: "a@x.com" }).onConflictDoUpdate([users.email], { name: "New" })
    ).not.toThrow()
  })
})
