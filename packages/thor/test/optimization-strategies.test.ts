import { describe, expect, it } from "vitest"
import { asc, db, eq, param, pg } from "@gilvandovieira/thor"
import {
  bitsToCapabilities,
  capabilitiesToBits
} from "@gilvandovieira/thor/capabilities"
import { tableMeta } from "@gilvandovieira/thor/schema"
import { Schema } from "effect"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

describe("required optimization strategies (spec §15.14)", () => {
  it("memoizes readable capability sets by bitset", () => {
    const bits = capabilitiesToBits(["select.cte", "query.preparedStatements"])
    const first = bitsToCapabilities(bits)
    const second = bitsToCapabilities(bits)

    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it("path-copies fluent query IR without deep-cloning stable metadata", () => {
    const base = db.select({ id: users.id }).from(users)
    const filtered = base.where(eq(users.email, param("email", Schema.String)))
    const ordered = filtered.orderBy(asc(users.id))

    expect(filtered.ir).not.toBe(base.ir)
    expect(filtered.ir.from).toBe(base.ir.from)
    expect(filtered.ir.selection).toBe(base.ir.selection)
    expect(filtered.ir.orderBy).toBe(base.ir.orderBy)

    expect(ordered.ir).not.toBe(filtered.ir)
    expect(ordered.ir.from).toBe(filtered.ir.from)
    expect(ordered.ir.selection).toBe(filtered.ir.selection)
    expect(ordered.ir.orderBy).not.toBe(filtered.ir.orderBy)
  })

  it("reuses table and column metadata objects", () => {
    const first = tableMeta(users)
    const second = tableMeta(users)
    const query = db.select({ id: users.id }).from(users)

    expect(first).toBe(second)
    expect(first.columns.id).toBe(users.id)
    expect(query.ir.from.name).toBe(first.name)
  })
})
