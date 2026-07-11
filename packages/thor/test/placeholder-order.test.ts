import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { db, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import type { Dialect } from "@gilvandovieira/thor"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  age: pg.integer("age").nullable()
})

const paramNode = (name: string, value: unknown) => ({ _tag: "Param" as const, name, codec: Schema.Unknown, value })

/**
 * Finding 1 (critical) — the compiler must push parameters in the same order the
 * placeholders appear in the emitted SQL. Positional (`?`) dialects bind by
 * position, so a mismatch silently binds values to the wrong placeholders.
 */
describe("positional placeholder order matches SQL text (Finding 1)", () => {
  const dialects: ReadonlyArray<readonly [string, Dialect]> = [
    ["postgres", PostgresDialect],
    ["sqlite", SQLiteDialect],
    ["mysql", MySQLDialect]
  ]

  it.each(dialects)("binds IN-list params after the left expr on %s", (_name, dialect) => {
    // `<lhs> IN (<a>, <b>)` where the LEFT side itself carries a param.
    const inList = {
      _tag: "InList" as const,
      expr: paramNode("lhs", "LHS"),
      values: [paramNode("a", "A"), paramNode("b", "B")],
      negated: false
    }
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(inList as never)
    const compiled = dialect.compileQuery(query.ir)

    // Textual order is expr, then list: LHS, A, B — regardless of dialect.
    expect(compiled.paramOrder.map((p) => p.value)).toEqual(["LHS", "A", "B"])
    // The left placeholder precedes the parenthesized list in the SQL.
    expect(compiled.sql).toMatch(/ IN \(/)
    expect(compiled.sql.indexOf("IN (")).toBeGreaterThan(compiled.sql.indexOf("WHERE"))
  })

  it.each(dialects)("binds window function args before OVER clauses on %s", (_name, dialect) => {
    // `sum(<arg>) OVER (PARTITION BY <part>)` — both sides carry a param.
    const windowExpr = {
      node: {
        _tag: "WindowFunction" as const,
        function: {
          _tag: "FunctionCall" as const,
          name: "sum",
          declared: false,
          star: false,
          args: [paramNode("arg", "ARG")],
          capabilities: 0n
        },
        partitionBy: [paramNode("part", "PART")],
        orderBy: [],
        frame: undefined
      },
      codec: Schema.Unknown
    }
    const query = db.select({ n: windowExpr as never }).from(users)
    const compiled = dialect.compileQuery(query.ir)

    // Textual order is the function argument, then the PARTITION BY clause.
    expect(compiled.paramOrder.map((p) => p.value)).toEqual(["ARG", "PART"])
    expect(compiled.sql.indexOf("OVER")).toBeGreaterThan(
      compiled.sql.indexOf("sum") >= 0 ? compiled.sql.indexOf("sum") : compiled.sql.indexOf("SUM")
    )
  })
})
