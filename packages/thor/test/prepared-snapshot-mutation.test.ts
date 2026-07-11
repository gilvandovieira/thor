import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  type Database,
  asc,
  currentRow,
  db,
  eq,
  excluded,
  param,
  pg,
  preceding,
  rowNumber,
  rowsBetween,
  sql
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("snapshot_users", {
  id: pg.text("id").primaryKey(),
  email: pg.text("email").notNull()
})

const run = <A, E>(effect: Effect.Effect<A, E, Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("prepared and compiled handle snapshots", () => {
  it("does not observe mutation of a raw expression after prepare()", () => {
    const expression = sql`${users.id} IS NOT NULL`
    const prepared = db.select({ id: users.id }).from(users).where(expression).prepare("raw-snapshot")

    ;(expression.strings as string[])[0] = "1); DROP TABLE snapshot_users; --"

    expect(prepared.toSql().sql).toBe(
      'SELECT "snapshot_users"."id" AS "id" FROM "snapshot_users" WHERE "snapshot_users"."id" IS NOT NULL'
    )
  })

  it("does not observe mutation of a named parameter node after prepare()", async () => {
    const email = param("email", Schema.String)
    const prepared = db.select({ id: users.id }).from(users).where(eq(users.email, email)).prepare("param-snapshot")
    ;(email as { name: string }).name = "forged"
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(prepared.all({ email: "safe@example.com" }), driver)

    expect(driver.calls[0]?.params).toEqual(["safe@example.com"])
  })

  it("does not observe source mutation after compile()", async () => {
    const email = param("email", Schema.String)
    const compiled = db.select({ id: users.id }).from(users).where(eq(users.email, email)).all().compile()
    ;(email as { name: string }).name = "forged"
    const driver = new FakeDriver().enqueue({ rows: [] })

    await run(compiled.execute({ email: "safe@example.com" }), driver)

    expect(driver.calls[0]?.params).toEqual(["safe@example.com"])
  })

  it("owns window arrays, frames, aliases, SQL, cache keys, and inspection", () => {
    const orderBy = [asc(users.id)]
    const frame = rowsBetween(preceding(2), currentRow)
    const window = rowNumber().over({ partitionBy: [users.email], orderBy, frame })
    const query = db.select({ rank: window }).from(users)
    const prepared = query.prepare("window-snapshot")
    const beforeSql = prepared.toSql()
    const beforeInspection = prepared.inspect()

    ;(orderBy[0] as { direction: string }).direction = "desc"
    ;(frame.start as { offset: number }).offset = 99
    ;((window.node as any).partitionBy as unknown[]).length = 0
    ;((query as any).ir.selection[0] as { alias: string }).alias = "forged"

    expect(prepared.toSql()).toEqual(beforeSql)
    expect(prepared.inspect()).toEqual(beforeInspection)
  })

  it("owns nested CTE and set-operation operands", () => {
    const body = db.select({ id: users.id }).from(users)
    const cte = db.cte("snapshot_cte", body)
    const rhs = db.select({ id: users.id }).from(users)
    const query = db
      .select({ id: cte.field("id") })
      .from(cte)
      .union(rhs)
    const prepared = query.prepare("nested-snapshot")
    const before = prepared.toSql()
    const inspection = prepared.inspect()

    ;((body as any).ir.selection[0] as { alias: string }).alias = "body_forged"
    ;((rhs as any).ir.selection[0] as { alias: string }).alias = "rhs_forged"
    ;((query as any).ir.ctes as unknown[]).length = 0
    ;((query as any).ir.setOperations as unknown[]).length = 0

    expect(prepared.toSql()).toEqual(before)
    expect(prepared.inspect()).toEqual(inspection)
  })

  it("owns mutation rows, conflict assignments, returning aliases, and table metadata", async () => {
    const id = param("id", Schema.String)
    const email = param("email", Schema.String)
    const mutation = db
      .insert(users)
      .values({ id, email })
      .onConflictDoUpdate([users.email], { email: excluded(users.email) })
      .returning({ selectedEmail: users.email })
    const compiled = mutation.one().compile()
    const cacheKey = compiled.cacheKey
    const originalTable = users.id.def.table
    const originalColumn = users.id.def.name
    const ir = mutation.ir as any

    ir.rows[0][1].name = "forged"
    ir.conflict.set[0].column = "forged"
    ir.returning[0].alias = "forged"
    ;(users.id.def as { table: string; name: string }).table = "forged_table"
    ;(users.id.def as { table: string; name: string }).name = "forged_column"
    const driver = new FakeDriver().enqueue({ rows: [{ selectedEmail: "safe@example.com" }] })

    try {
      await run(compiled.execute({ id: "id", email: "safe@example.com" }), driver)
      expect(compiled.cacheKey).toBe(cacheKey)
      expect(driver.calls[0]?.sql).toContain('INSERT INTO "snapshot_users"')
      expect(driver.calls[0]?.sql).toContain('DO UPDATE SET "email" = EXCLUDED."email"')
      expect(driver.calls[0]?.params).toEqual(["id", "safe@example.com"])
    } finally {
      ;(users.id.def as { table: string; name: string }).table = originalTable
      ;(users.id.def as { table: string; name: string }).name = originalColumn
    }
  })
})
