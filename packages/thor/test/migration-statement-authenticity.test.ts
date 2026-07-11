import { describe, expect, it } from "vitest"
import { isSqlStatement } from "@gilvandovieira/thor/migrate"

describe("migration statement runtime authenticity", () => {
  it("rejects a plain object that imitates generated migration syntax", () => {
    const forged = { _tag: "SqlStatement", sql: "drop table users" }

    expect(isSqlStatement(forged as never)).toBe(false)
  })

  it("rejects malformed structural statements before dereferencing sql", () => {
    const forged = { _tag: "SqlStatement", sql: 42 }

    expect(isSqlStatement(forged as never)).toBe(false)
  })
})
