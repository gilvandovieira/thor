import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect } from "effect"
import type { Connection as MySQL2Connection } from "mysql2/promise"
import { ConstraintError } from "@gilvandovieira/thor"
import {
  makeMySQLDriver,
  mapMySQLDriverError,
  type MySQLClient,
  type MySQLQueryResult
} from "@gilvandovieira/thor/mysql"

class FakeMySQLClient implements MySQLClient {
  readonly calls: Array<{ readonly method: "query" | "execute"; readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = []
  private readonly results: MySQLQueryResult[] = []
  private readonly errors: unknown[] = []

  enqueue(...results: ReadonlyArray<MySQLQueryResult>): this {
    this.results.push(...results)
    return this
  }

  fail(error: unknown): this {
    this.errors.push(error)
    return this
  }

  query = async (sql: string, params?: ReadonlyArray<unknown>): Promise<MySQLQueryResult> => {
    this.calls.push(params ? { method: "query", sql, params } : { method: "query", sql })
    return this.next()
  }

  execute = async (sql: string, params?: ReadonlyArray<unknown>): Promise<MySQLQueryResult> => {
    this.calls.push(params ? { method: "execute", sql, params } : { method: "execute", sql })
    return this.next()
  }

  private next(): MySQLQueryResult {
    const error = this.errors.shift()
    if (error) throw error
    return this.results.shift() ?? [{ affectedRows: 0 }, []]
  }
}

describe("MySQL driver adapter", () => {
  it("accepts a mysql2 PromiseConnection without wrapper types", () => {
    expectTypeOf<MySQL2Connection>().toExtend<MySQLClient>()
  })

  it("uses mysql2 prepared execution and returns rows", async () => {
    const client = new FakeMySQLClient().enqueue([[{ id: "u1" }], []])
    const driver = makeMySQLDriver(client)

    const rows = await Effect.runPromise(driver.query("select * from `users` where `id` = ?", ["u1"], "mysql:key"))

    expect(rows).toStrictEqual([{ id: "u1" }])
    expect(client.calls).toStrictEqual([
      { method: "execute", sql: "select * from `users` where `id` = ?", params: ["u1"] }
    ])
  })

  it("normalizes values and maps affectedRows", async () => {
    const client = new FakeMySQLClient().enqueue([{ affectedRows: 2 }, []])
    const driver = makeMySQLDriver(client)

    const result = await Effect.runPromise(
      driver.execute("update `users` set `active` = ?, `profile` = ?", [true, { role: "admin" }], "mysql:key")
    )

    expect(result).toStrictEqual({ rowCount: 2 })
    expect(client.calls[0]?.params).toStrictEqual([1, '{"role":"admin"}'])
  })

  it("runs parameter-free scripts through query()", async () => {
    const client = new FakeMySQLClient().enqueue([{ affectedRows: 0 }, []])
    const driver = makeMySQLDriver(client)

    await Effect.runPromise(driver.executeScript!("create table `users` (`id` int);"))

    expect(client.calls).toStrictEqual([
      { method: "query", sql: "create table `users` (`id` int);" }
    ])
  })

  it("maps mysql2 constraint errors to Thor errors", async () => {
    const native = { errno: 1062, code: "ER_DUP_ENTRY", sqlState: "23000", message: "Duplicate entry" }
    const client = new FakeMySQLClient().fail(native)
    const driver = makeMySQLDriver(client)

    const error = await Effect.runPromise(Effect.flip(driver.execute("insert into `users` values (?)", ["u1"])))

    expect(error).toBeInstanceOf(ConstraintError)
    expect(error).toMatchObject({ _tag: "ConstraintError", kind: "unique", message: "Duplicate entry" })
    expect(mapMySQLDriverError(native)).toMatchObject({ _tag: "ConstraintError", kind: "unique" })
  })
})
