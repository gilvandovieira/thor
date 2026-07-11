import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeSQLiteDriver } from "@gilvandovieira/thor/sqlite"

describe("SQLite transient prepared statements", () => {
  it("finalizes a collision fallback after query execution", async () => {
    const finalized: string[] = []
    const client = {
      prepare: (sql: string) => ({
        all: () => [],
        run: () => ({ changes: 0 }),
        finalize: () => finalized.push(sql)
      }),
      exec: () => undefined
    }
    const driver = makeSQLiteDriver(client)

    await Effect.runPromise(driver.query("select 1", [], "collision"))
    await Effect.runPromise(driver.query("select 2", [], "collision"))

    expect(finalized).toEqual(["select 2"])
  })

  it("finalizes unnamed query and command statements on success and failure", async () => {
    const finalized: string[] = []
    const client = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql === "fail") throw new Error("boom")
          return []
        },
        run: () => ({ changes: 0 }),
        finalize: () => finalized.push(sql)
      }),
      exec: () => undefined
    }
    const driver = makeSQLiteDriver(client)

    await Effect.runPromise(driver.query("select 1", []))
    await Effect.runPromise(driver.execute("update users set id = id", []))
    await Effect.runPromiseExit(driver.query("fail", []))

    expect(finalized).toEqual(["select 1", "update users set id = id", "fail"])
  })
})
