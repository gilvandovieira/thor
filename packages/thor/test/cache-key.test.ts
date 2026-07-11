import { describe, expect, it } from "vitest"
import { capabilityProfileHash, defineCapabilities, dialectProfileHash } from "@gilvandovieira/thor/capabilities"
import {
  DEFAULT_DECODE_MODE,
  DEFAULT_EXECUTION_MODE,
  PostgresDialect,
  SQLiteDialect,
  db,
  eq,
  pg,
  planKey
} from "@gilvandovieira/thor"
import { queryStructuralHash } from "../src/ir/structural-hash.js"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

describe("cache-key composition (spec §15.14)", () => {
  it("hashes a dialect's capability profile stably and distinctly", () => {
    const a = defineCapabilities("db", { "insert.returning": "native" })
    const b = defineCapabilities("db", { "insert.returning": "unsupported" })

    expect(capabilityProfileHash(a)).toMatch(/^[0-9a-f]{8}$/)
    expect(capabilityProfileHash(a)).toBe(capabilityProfileHash(a)) // stable
    // Same dialect id, different capability profile → different hash.
    expect(capabilityProfileHash(a)).not.toBe(capabilityProfileHash(b))
    expect(dialectProfileHash("db", "1", a)).not.toBe(dialectProfileHash("db", "2", a))
    expect(dialectProfileHash("db", "1", a)).not.toBe(dialectProfileHash("db", "1", b))
  })

  it("composes the plan key from compiled shape + execution + decode mode", () => {
    const compiled = { sql: "select 1", paramOrder: [], cacheKey: "postgres:aaaaaaaa:bbbbbbbb" }

    expect(planKey(compiled)).toBe(`postgres:aaaaaaaa:bbbbbbbb:${DEFAULT_EXECUTION_MODE}:${DEFAULT_DECODE_MODE}`)
    expect(planKey(compiled, "trusted", "trusted")).toBe("postgres:aaaaaaaa:bbbbbbbb:trusted:trusted")
    // Never includes parameter values — it is derived only from the shape + modes.
    expect(planKey(compiled)).not.toContain("1")
  })

  it("hashes IR shape independently of inline parameter values", () => {
    const first = db.select({ id: users.id }).from(users).where(eq(users.email, "ada@example.com"))
    const second = db.select({ id: users.id }).from(users).where(eq(users.email, "grace@example.com"))
    const limited = second.limit(1)

    expect(queryStructuralHash(first.ir)).toBe(queryStructuralHash(second.ir))
    expect(queryStructuralHash(first.ir)).not.toBe(queryStructuralHash(limited.ir))
  })

  it("uses the same IR structural hash inside every dialect cache key", () => {
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, "ada@example.com"))
    const structuralHash = queryStructuralHash(query.ir)
    const postgres = query.toSql(PostgresDialect)
    const sqlite = query.toSql(SQLiteDialect)

    expect(postgres.cacheKey).toBe(`postgres:${PostgresDialect.profileHash}:${structuralHash}`)
    expect(sqlite.cacheKey).toBe(`sqlite:${SQLiteDialect.profileHash}:${structuralHash}`)
    expect(postgres.cacheKey.split(":")[2]).toBe(sqlite.cacheKey.split(":")[2])
  })

  it("changes structural identity for meaningful query-shape differences", () => {
    const base = db.select({ id: users.id }).from(users)
    const filtered = base.where(eq(users.email, "ada@example.com"))
    const selected = db.select({ email: users.email }).from(users)

    expect(queryStructuralHash(base.ir)).not.toBe(queryStructuralHash(filtered.ir))
    expect(queryStructuralHash(base.ir)).not.toBe(queryStructuralHash(selected.ir))
  })
})
