import { describe, expect, it } from "vitest"
import { db, pg } from "@gilvandovieira/thor"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"

const dialects = [PostgresDialect, SQLiteDialect, MySQLDialect] as const

describe("identifier validity policy", () => {
  it.each(["", "bad\0name"])("rejects %j before compilation", (name) => {
    for (const dialect of dialects) expect(() => dialect.quoteIdent(name)).toThrow(TypeError)
    expect(() => pg.table(name, { id: pg.text("id") })).toThrow(TypeError)
    expect(() => pg.table("valid", { id: pg.text(name) })).toThrow(TypeError)
  })

  it.each(["line\nbreak", 'double"quote', "back`tick", "select", "schema.table", "e\u0301", "é", "🛡️", "a".repeat(512)])(
    "quotes and permits opaque identifier %j",
    (name) => {
      const table = pg.table(name, { value: pg.text(name) })
      for (const dialect of dialects) {
        const statement = db
          .select({ [name]: table.value })
          .from(table)
          .toSql(dialect)
        expect(statement.sql).toContain(dialect.quoteIdent(name))
      }
    }
  )

  it("treats dots as one opaque identifier rather than implicit qualification", () => {
    const table = pg.table("tenant.users", { id: pg.text("user.id") })
    expect(db.select({ id: table.id }).from(table).toSql(PostgresDialect).sql).toBe(
      'SELECT "tenant.users"."user.id" AS "id" FROM "tenant.users"'
    )
  })
})
