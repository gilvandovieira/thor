import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { CapabilityError, Database, DriverError, TransactionError, db } from "@gilvandovieira/thor"
import { MySQLDialect } from "@gilvandovieira/thor/mysql"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const statement = (sql: string) => Effect.flatMap(Database, (database) => database.driver.execute(sql, []))

describe("transaction-scoped database API", () => {
  it("commits successful work on the transaction connection", async () => {
    const driver = new FakeDriver()
    const result = await Effect.runPromise(
      Effect.provide(db.transaction(statement("work").pipe(Effect.as("done"))), FakeDatabaseLayer(driver))
    )

    expect(result).toBe("done")
    expect(driver.calls.map((call) => call.sql)).toEqual(["begin", "work", "commit"])
  })

  it("rolls back failed and interrupted bodies", async () => {
    const failed = new FakeDriver()
    const failure = await Effect.runPromiseExit(
      Effect.provide(db.transaction(Effect.fail("body failed")), FakeDatabaseLayer(failed))
    )
    expect(Exit.isFailure(failure)).toBe(true)
    expect(failed.calls.map((call) => call.sql)).toEqual(["begin", "rollback"])

    const interrupted = new FakeDriver()
    const interruption = await Effect.runPromiseExit(
      Effect.provide(db.transaction(Effect.interrupt), FakeDatabaseLayer(interrupted))
    )
    expect(Exit.isFailure(interruption)).toBe(true)
    expect(interrupted.calls.map((call) => call.sql)).toEqual(["begin", "rollback"])
  })

  it("uses savepoints for nested transactions", async () => {
    const driver = new FakeDriver()
    await Effect.runPromise(Effect.provide(db.transaction(db.transaction(Effect.void)), FakeDatabaseLayer(driver)))

    expect(driver.calls.map((call) => call.sql)).toEqual([
      "begin",
      "savepoint thor_sp_1",
      "release savepoint thor_sp_1",
      "commit"
    ])
  })

  it("preserves both the body and rollback failure causes", async () => {
    const driver = new FakeDriver().enqueue(
      {},
      {
        error: new DriverError({ message: "rollback disconnected" })
      }
    )
    const exit = await Effect.runPromiseExit(
      Effect.provide(db.transaction(Effect.fail("body failed")), FakeDatabaseLayer(driver))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).toContain("body failed")
      expect(rendered).toContain("rollback disconnected")
    }
  })

  it("surfaces commit failures as TransactionError", async () => {
    const driver = new FakeDriver().enqueue(
      {},
      {
        error: new DriverError({ message: "commit disconnected" })
      }
    )
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(db.transaction(Effect.void), FakeDatabaseLayer(driver)))
    )

    expect(error).toBeInstanceOf(TransactionError)
    expect(error.message).toContain("commit disconnected")
  })

  it("retries only at an explicit outer boundary", async () => {
    const driver = new FakeDriver()
    let attempts = 0
    const body = Effect.suspend(() => (++attempts === 1 ? Effect.fail("retry me") : Effect.succeed("ok")))
    const result = await Effect.runPromise(
      Effect.provide(
        db.transaction(body, { retry: { times: 1, while: (error) => error === "retry me" } }),
        FakeDatabaseLayer(driver)
      )
    )

    expect(result).toBe("ok")
    expect(attempts).toBe(2)
    expect(driver.calls.map((call) => call.sql)).toEqual(["begin", "rollback", "begin", "commit"])
  })

  it("emits dialect-specific begin statements", async () => {
    const mysql = new FakeDriver()
    await Effect.runPromise(
      Effect.provide(
        db.transaction(Effect.void, { isolationLevel: "serializable", accessMode: "read-only" }),
        FakeDatabaseLayer(mysql, { dialect: MySQLDialect })
      )
    )
    expect(mysql.calls.map((call) => call.sql)).toEqual([
      "set transaction isolation level SERIALIZABLE",
      "start transaction read only",
      "commit"
    ])

    const sqlite = new FakeDriver()
    await Effect.runPromise(
      Effect.provide(
        db.transaction(Effect.void, { sqliteMode: "immediate" }),
        FakeDatabaseLayer(sqlite, { dialect: SQLiteDialect })
      )
    )
    expect(sqlite.calls.map((call) => call.sql)).toEqual(["begin immediate", "commit"])
  })

  it("guards emulated isolation before the driver unless explicitly enabled", async () => {
    const blocked = new FakeDriver()
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          db.transaction(Effect.void, { isolationLevel: "serializable" }),
          FakeDatabaseLayer(blocked, { dialect: SQLiteDialect })
        )
      )
    )
    expect(error).toBeInstanceOf(CapabilityError)
    expect(blocked.calls).toEqual([])

    const enabled = new FakeDriver()
    await Effect.runPromise(
      Effect.provide(
        db.transaction(Effect.void, { isolationLevel: "serializable" }),
        FakeDatabaseLayer(enabled, { dialect: SQLiteDialect, allowEmulation: true })
      )
    )
    expect(enabled.calls.map((call) => call.sql)).toEqual(["begin immediate", "commit"])
  })

  it.each([
    { isolationLevel: "serializable" as const },
    { accessMode: "read-only" as const },
    { sqliteMode: "immediate" as const }
  ])("rejects nested outer transaction options: %o", async (options) => {
    const driver = new FakeDriver()
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(db.transaction(db.transaction(Effect.void, options)), FakeDatabaseLayer(driver)))
    )

    expect(error).toBeInstanceOf(TransactionError)
    expect(error.message).toContain("start options")
    expect(driver.calls.map((call) => call.sql)).toEqual(["begin", "rollback"])
  })
})
