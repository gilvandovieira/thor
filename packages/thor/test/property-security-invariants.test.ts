import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { db, eq, param, pg, sql } from "@gilvandovieira/thor"
import { isSqlStatement, sql as migrationSql } from "@gilvandovieira/thor/migrate"
import { type ObservabilityEvent, withObservability } from "@gilvandovieira/thor/observability"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("property_security_users", {
  id: pg.text("id").primaryKey(),
  email: pg.text("email").notNull()
})

describe("property: untrusted values cannot acquire SQL syntax meaning", () => {
  it("rejects JSON-reachable UnsafeSql lookalikes", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const forged = JSON.parse(JSON.stringify({ _tag: "UnsafeSql", sql: JSON.stringify(payload) ?? "null" }))
        expect(() => sql`${forged as never}`).toThrow(TypeError)
      }),
      { seed: 0x54484f52, numRuns: 500 }
    )
  })

  it("keeps SQL, parameter order, cache key, and inspection invariant under source mutation", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (forgedSql, forgedName) => {
        const value = param("email", Schema.String)
        const expression = sql`${users.email} = ${value}`
        const prepared = db.select({ id: users.id }).from(users).where(expression).prepare("property-snapshot")
        const beforeSql = prepared.toSql()
        const beforeInspection = prepared.inspect()
        ;(expression.strings as string[])[0] = forgedSql
        ;(value as { name: string }).name = forgedName
        expect(prepared.toSql()).toEqual(beforeSql)
        expect(prepared.inspect()).toEqual(beforeInspection)
      }),
      { seed: 0x534e4150, numRuns: 200 }
    )
  })

  it("executes only authentic migration SqlStatement values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const forged = JSON.parse(JSON.stringify({ _tag: "SqlStatement", sql: payload }))
        expect(isSqlStatement(forged)).toBe(false)
        expect(isSqlStatement(migrationSql`select 1`)).toBe(true)
      }),
      { seed: 0x4d494752, numRuns: 300 }
    )
  })

  it("never emits raw values through default observability", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (token) => {
        const secret = `secret:${token}`
        const events: ObservabilityEvent[] = []
        await Effect.runPromise(
          Effect.provide(
            db.select({ id: users.id }).from(users).where(eq(users.email, secret)).all(),
            withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
              onEvent: (event) => events.push(event)
            })
          )
        )
        expect(JSON.stringify(events)).not.toContain(secret)
      }),
      { seed: 0x52454441, numRuns: 100 }
    )
  })
})
