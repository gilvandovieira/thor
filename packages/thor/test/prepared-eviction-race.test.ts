import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Database, type DatabaseService, type Driver, PostgresDialect, db, eq, param, pg } from "@gilvandovieira/thor"
import { makeQueryCaches } from "../src/execution/cache.js"

const users = pg.table("eviction_users", {
  id: pg.text("id").primaryKey(),
  email: pg.text("email").notNull()
})

describe("prepared eviction concurrency", () => {
  it("does not release a prepared identity while its query is executing", async () => {
    let markStarted!: () => void
    let unblockFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const firstUnblocked = new Promise<void>((resolve) => {
      unblockFirst = resolve
    })
    const active = new Set<string>()
    const releasedWhileActive: string[] = []
    let calls = 0

    const driver: Driver = {
      runtime: { adapter: "prepared-race", required: [] },
      query: (_sql, _params, name) =>
        Effect.tryPromise({
          try: async () => {
            calls++
            if (name) active.add(name)
            if (calls === 1) {
              markStarted()
              await firstUnblocked
            }
            if (name) active.delete(name)
            return []
          },
          catch: (cause) => cause as never
        }),
      execute: () => Effect.succeed({ rowCount: 0 }),
      releasePrepared: (name) =>
        Effect.sync(() => {
          if (active.has(name)) releasedWhileActive.push(name)
        })
    }
    const layer = Layer.succeed(Database, {
      dialect: PostgresDialect,
      driver,
      allowEmulation: false,
      preparedStatements: true,
      queryCache: makeQueryCaches({ preparedMaxSize: 1 })
    } satisfies DatabaseService)
    const first = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, param("id", Schema.String)))
    const second = db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))

    const firstRun = Effect.runPromise(Effect.provide(first.all({ id: "1" }), layer))
    await firstStarted
    await Effect.runPromise(Effect.provide(second.all({ email: "a@example.com" }), layer))
    unblockFirst()
    await firstRun

    expect(releasedWhileActive).toEqual([])
  })
})
