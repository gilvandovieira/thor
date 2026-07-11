import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { db, eq, sqlite } from "@gilvandovieira/thor"
import { makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { makeSQLiteDriver, SQLiteLayer } from "@gilvandovieira/thor/sqlite"

describe("SQLite prepared resource lifecycle", () => {
  it("finalizes evicted and cleared cached statements where the runtime exposes finalization", async () => {
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

    await Effect.runPromise(driver.query("select ?", [1], "sqlite:first"))
    await Effect.runPromise(driver.query("select ? + 1", [1], "sqlite:second"))
    await Effect.runPromise(driver.releasePrepared!("sqlite:first"))
    await Effect.runPromise(driver.clearPrepared!())

    expect(finalized).toEqual(["select ?", "select ? + 1"])
  })

  it("never reuses the wrong statement when prepared identities collide", async () => {
    const prepared: string[] = []
    const client = {
      prepare: (sql: string) => {
        prepared.push(sql)
        return { all: () => [{ sql }], run: () => ({ changes: 0 }) }
      },
      exec: () => undefined
    }
    const driver = makeSQLiteDriver(client)

    const first = await Effect.runPromise(driver.query("select 1", [], "collision"))
    const second = await Effect.runPromise(driver.query("select 2", [], "collision"))

    expect(first).toEqual([{ sql: "select 1" }])
    expect(second).toEqual([{ sql: "select 2" }])
    expect(prepared).toEqual(["select 1", "select 2"])
  })

  it("finalizes transient query and execute statements on every completion path", async () => {
    const finalized: string[] = []
    const client = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes("fail")) throw new Error("boom")
          return []
        },
        run: () => {
          if (sql.includes("fail")) throw new Error("boom")
          return { changes: 0 }
        },
        finalize: () => finalized.push(sql)
      }),
      exec: () => undefined
    }
    const driver = makeSQLiteDriver(client)

    await Effect.runPromise(driver.query("cached query", [], "query-collision"))
    await Effect.runPromise(driver.query("query collision", [], "query-collision"))
    await Effect.runPromiseExit(driver.query("query collision fail", [], "query-collision"))
    await Effect.runPromise(driver.execute("cached execute", [], "execute-collision"))
    await Effect.runPromise(driver.execute("execute collision", [], "execute-collision"))
    await Effect.runPromiseExit(driver.execute("execute collision fail", [], "execute-collision"))
    await Effect.runPromise(driver.query("unnamed query", []))
    await Effect.runPromiseExit(driver.query("unnamed query fail", []))
    await Effect.runPromise(driver.execute("unnamed execute", []))
    await Effect.runPromiseExit(driver.execute("unnamed execute fail", []))

    expect(finalized).toEqual([
      "query collision",
      "query collision fail",
      "execute collision",
      "execute collision fail",
      "unnamed query",
      "unnamed query fail",
      "unnamed execute",
      "unnamed execute fail"
    ])
  })
})

const supportsNodeSqlite = Number(process.versions.node.split(".")[0]) >= 22

describe.skipIf(!supportsNodeSqlite)("SQLite in-memory integration", () => {
  it("migrates, writes, returns, filters, and decodes through the SQLite dialect", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const client = new DatabaseSync(":memory:")
    const users = sqlite.table("users", {
      id: sqlite.uuid("id").primaryKey().defaultRandom(),
      email: sqlite.text("email").notNull(),
      active: sqlite.boolean("active").notNull().default(true),
      profile: sqlite.json("profile", Schema.Struct({ role: Schema.String })).notNull(),
      createdAt: sqlite.timestamp("created_at").notNull().defaultNow()
    })

    try {
      const layer = SQLiteLayer(client)
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const migrator = yield* makeMigrator({ schema: [users] })
            yield* migrator.apply({
              id: "20260709_create_users",
              name: "create_users",
              operations: [tableToCreateOp(users)]
            })
            const inserted = yield* db
              .insert(users)
              .values({ email: "ada@example.com", profile: { role: "admin" } })
              .returning({
                id: users.id,
                active: users.active,
                profile: users.profile,
                createdAt: users.createdAt
              })
              .one()
            const selected = yield* db
              .select({ id: users.id, email: users.email, active: users.active, profile: users.profile })
              .from(users)
              .where(eq(users.id, inserted.id))
              .one()
            const status = yield* migrator.status()
            const drift = yield* migrator.drift()
            return { inserted, selected, status, drift }
          }),
          layer
        )
      )

      expect(result.inserted.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.inserted.active).toBe(true)
      expect(result.inserted.profile).toStrictEqual({ role: "admin" })
      expect(result.inserted.createdAt).toBeInstanceOf(Date)
      expect(result.selected).toStrictEqual({
        id: result.inserted.id,
        email: "ada@example.com",
        active: true,
        profile: { role: "admin" }
      })
      expect(result.status).toHaveLength(1)
      expect(result.status[0]).toMatchObject({ id: "20260709_create_users", name: "create_users" })
      expect(result.drift).toEqual([])
    } finally {
      client.close()
    }
  })
})
