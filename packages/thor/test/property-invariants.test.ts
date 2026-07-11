import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { db, inArray, notInArray, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import { expectSql } from "@gilvandovieira/thor/testing"
import { checksum, defineMigration, guardOperations, type MigrationOperation } from "@gilvandovieira/thor/migrate"
import { BoundedLruCache } from "../src/execution/cache.js"

const DEFAULT_SEED = 0x54484f52
const configuredSeed = Number(process.env.FC_SEED ?? DEFAULT_SEED)
const configuredRuns = Number(process.env.FC_NUM_RUNS ?? 100)

/**
 * @param offset - Stable per-property seed offset.
 * @returns Reproducible fast-check parameters.
 */
const params = (offset: number): fc.Parameters<unknown> => ({
  seed: configuredSeed + offset,
  numRuns: configuredRuns,
  endOnFailure: true
})

const users = pg.table("users", {
  id: pg.integer("id").primaryKey(),
  email: pg.text("email").notNull(),
  age: pg.integer("age").nullable()
})

const dialects = [PostgresDialect, SQLiteDialect, MySQLDialect] as const

describe("remediation property invariants (P3.5)", () => {
  it("pagination guards reject every non-finite, negative, or fractional value", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noInteger: true }).filter((n) => Number.isFinite(n)),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
          fc.integer({ min: -1_000_000, max: -1 })
        ),
        (bad) => {
          expect(() => db.select({ id: users.id }).from(users).limit(bad)).toThrow(
            expect.objectContaining({ _tag: "GuardError" })
          )
          expect(() => db.select({ id: users.id }).from(users).offset(bad)).toThrow(
            expect.objectContaining({ _tag: "GuardError" })
          )
        }
      ),
      params(1)
    )
  })

  it("valid pagination values always compile to a literal count with a matching bind list", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (limit, offset) => {
        const compiled = expectSql(db.select({ id: users.id }).from(users).limit(limit).offset(offset))
        expect(compiled.sql).toContain(`LIMIT ${limit}`)
        expect(compiled.sql).toContain(`OFFSET ${offset}`)
        // Pagination is inlined, not a placeholder, so no stray params appear.
        expect(compiled.params).toEqual([])
      }),
      params(2)
    )
  })

  it("empty IN / NOT IN lower to constant SQL with no placeholders on every dialect", () => {
    fc.assert(
      fc.property(fc.constantFrom("in" as const, "notIn" as const), (kind) => {
        const predicate = kind === "in" ? inArray(users.id, []) : notInArray(users.id, [])
        for (const dialect of dialects) {
          const { sql: text } = db.select({ id: users.id }).from(users).where(predicate).toSql(dialect)
          expect(text).toMatch(kind === "in" ? /WHERE\s+FALSE/i : /WHERE\s+TRUE/i)
          expect(text).not.toContain("IN ()")
          if (dialect === PostgresDialect) expect(text).not.toContain("$1")
          else expect(text).not.toContain("?")
        }
      }),
      params(3)
    )
  })

  it("identifier quoting round-trips arbitrary column names without breaking the literal", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (name) => {
        for (const dialect of dialects) {
          const quoted = dialect.quoteIdent(name)
          // The quoted identifier re-embeds the raw name with the quote char doubled.
          const quoteChar = quoted[0]!
          const inner = quoted.slice(1, -1)
          expect(inner.split(quoteChar + quoteChar).join(quoteChar)).toBe(name)
        }
      }),
      params(4)
    )
  })

  it("migration checksums are deterministic and change with execution-relevant fields", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ maxLength: 60 }),
        (id, name, body) => {
          const up = { _tag: "SqlStatement", sql: body } as const
          const base = defineMigration({ id, name, safety: "additive", phase: "expand", up })
          expect(checksum(base)).toBe(checksum(base))
          // Changing the destructive/phase classification changes the fingerprint.
          const reclassified = defineMigration({ id, name, safety: "destructive", phase: "contract", up })
          expect(checksum(reclassified)).not.toBe(checksum(base))
        }
      ),
      params(5)
    )
  })

  it("migration policy is monotonic: anything safe-only allows, a reviewed destructive run also allows", () => {
    const additive: MigrationOperation = {
      _tag: "AddColumn",
      table: "users",
      column: { name: "nickname", type: "text", nullable: true },
      destructive: false,
      reversible: true,
      capabilities: []
    }
    const destructive: MigrationOperation = {
      _tag: "DropColumn",
      table: "users",
      column: "nickname",
      destructive: true,
      reversible: false,
      capabilities: []
    }
    fc.assert(
      fc.property(fc.array(fc.constantFrom(additive, destructive), { maxLength: 6 }), (ops) => {
        const safeOk = guardOperations(ops, "safe-only").length === 0
        const reviewedOk = guardOperations(ops, "allow-reviewed-destructive", { reviewed: true }).length === 0
        // Every plan a strict policy accepts, the reviewed-destructive policy also accepts.
        if (safeOk) expect(reviewedOk).toBe(true)
      }),
      params(6)
    )
  })

  it("a bounded LRU never exceeds its configured size across thousands of distinct shapes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 32 }), fc.integer({ min: 100, max: 3000 }), (maxSize, shapes) => {
        const cache = new BoundedLruCache<object, number>("prepared", maxSize)
        for (let i = 0; i < shapes; i++) {
          cache.getOrCompute({}, () => i)
          expect(cache.stats().size).toBeLessThanOrEqual(maxSize)
        }
        expect(cache.stats().size).toBe(Math.min(maxSize, shapes))
      }),
      params(7)
    )
  })
})
