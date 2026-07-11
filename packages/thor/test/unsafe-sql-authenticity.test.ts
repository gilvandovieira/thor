import { describe, expect, it } from "vitest"
import { pg, rowNumber, sql as querySql } from "@gilvandovieira/thor"
import { rawSql, sql as migrationSql } from "@gilvandovieira/thor/migrate"

const hostile = "1); DROP TABLE users; --"

const forgeries = (): ReadonlyArray<unknown> => {
  const inheritedTag = Object.create({ _tag: "UnsafeSql" })
  inheritedTag.sql = hostile
  const inheritedSql = Object.create({ sql: hostile })
  inheritedSql._tag = "UnsafeSql"
  const nullPrototype = Object.assign(Object.create(null), { _tag: "UnsafeSql", sql: hostile })
  const changing = {
    _tag: "UnsafeSql",
    calls: 0,
    get sql() {
      this.calls++
      return this.calls === 1 ? "1" : hostile
    }
  }

  return [
    { _tag: "UnsafeSql", sql: hostile },
    JSON.parse(JSON.stringify({ _tag: "UnsafeSql", sql: hostile })),
    inheritedTag,
    inheritedSql,
    new Proxy({ _tag: "UnsafeSql", sql: hostile }, {}),
    Object.freeze({ _tag: "UnsafeSql", sql: hostile }),
    nullPrototype,
    Object.defineProperty({ _tag: "UnsafeSql" }, "sql", {
      get() {
        throw new Error("forged getter was evaluated")
      }
    }),
    changing,
    { _tag: "UnsafeSql", sql: hostile, [Symbol.for("@gilvandovieira/thor/unsafe-sql")]: true }
  ]
}

describe("unsafe SQL runtime authenticity", () => {
  it("rejects ordinary object shapes at query and migration template boundaries", () => {
    for (const forged of forgeries()) {
      expect(() => querySql`${forged as never}`).toThrow(TypeError)
      expect(() => migrationSql`${forged as never}`).toThrow(TypeError)
      expect(() => rawSql`${forged as never}`).toThrow(TypeError)
    }
  })

  it("rejects forged nodes at schema and window boundaries", () => {
    for (const forged of forgeries()) {
      expect(() => pg.text("value").defaultSql(forged as never)).toThrow(TypeError)
      expect(() => pg.text("value").generatedAlwaysAs(forged as never)).toThrow(TypeError)
      expect(() =>
        pg.table("forged_check", { id: pg.integer("id") }, { checks: [{ name: "bad", expression: forged as never }] })
      ).toThrow(TypeError)
      expect(() => rowNumber().over({ frame: forged as never })).toThrow(TypeError)
    }
  })
})
