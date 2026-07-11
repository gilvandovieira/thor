import { describe, expect, it } from "vitest"
import { db, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"

const users = pg.table("users", { id: pg.uuid("id").primaryKey().defaultRandom() })

/**
 * Finding 13 — `OFFSET n` with no `LIMIT` is invalid on SQLite and MySQL. The
 * compiler must emit an explicit unbounded limit for those dialects.
 */
describe("offset-only pagination is valid per dialect (Finding 13)", () => {
  const query = db.select({ id: users.id }).from(users).offset(10)

  it("PostgreSQL allows a standalone OFFSET", () => {
    expect(query.toSql(PostgresDialect).sql).toMatch(/ OFFSET 10$/)
    expect(query.toSql(PostgresDialect).sql).not.toMatch(/LIMIT/)
  })

  it("SQLite emits LIMIT -1 OFFSET n", () => {
    expect(query.toSql(SQLiteDialect).sql).toMatch(/ LIMIT -1 OFFSET 10$/)
  })

  it("MySQL emits an unbounded LIMIT before OFFSET", () => {
    expect(query.toSql(MySQLDialect).sql).toMatch(/ LIMIT 18446744073709551615 OFFSET 10$/)
  })

  it("limit+offset still renders normally on every dialect", () => {
    const both = db.select({ id: users.id }).from(users).limit(5).offset(10)
    for (const dialect of [PostgresDialect, SQLiteDialect, MySQLDialect]) {
      expect(both.toSql(dialect).sql).toMatch(/ LIMIT 5 OFFSET 10$/)
    }
  })
})
