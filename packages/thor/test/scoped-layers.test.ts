import { Cause, Effect, Exit, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import {
  Database,
  DriverError,
  MySQLScopedLayer,
  PostgresPoolLayer,
  PostgresScopedLayer,
  SQLiteScopedLayer,
  type MySQLClient,
  type PgClient,
  type SQLiteClient
} from "@gilvandovieira/thor"

const pgClient: PgClient = {
  query: (() => Promise.resolve({ rows: [], rowCount: 0 })) as PgClient["query"]
}

const mysqlClient: MySQLClient = {
  query: async () => [[], []],
  execute: async () => [[], []]
}

const sqliteClient: SQLiteClient = {
  prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
  exec: () => undefined
}

describe("scoped database layers", () => {
  it("acquires and releases owned clients for each adapter", async () => {
    for (const [layer, events] of [
      (() => {
        const events: string[] = []
        return [
          PostgresScopedLayer({
            acquire: async () => {
              events.push("acquire")
              return pgClient
            },
            release: async () => {
              events.push("release")
            }
          }),
          events
        ] as const
      })(),
      (() => {
        const events: string[] = []
        return [
          MySQLScopedLayer({
            acquire: async () => {
              events.push("acquire")
              return mysqlClient
            },
            release: async () => {
              events.push("release")
            }
          }),
          events
        ] as const
      })(),
      (() => {
        const events: string[] = []
        return [
          SQLiteScopedLayer({
            acquire: () => {
              events.push("acquire")
              return sqliteClient
            },
            release: () => {
              events.push("release")
            }
          }),
          events
        ] as const
      })()
    ]) {
      await Effect.runPromise(Effect.provide(Effect.as(Database, undefined), layer))
      expect(events).toEqual(["acquire", "release"])
    }
  })

  it("releases a connection when its consumer is interrupted", async () => {
    let signalAcquired!: () => void
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve
    })
    let released = false
    const layer = PostgresScopedLayer({
      acquire: async () => {
        signalAcquired()
        return pgClient
      },
      release: async () => {
        released = true
      }
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.provide(Effect.never, layer))
        yield* Effect.promise(() => acquired)
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(released).toBe(true)
  })

  it("reports acquisition and pool-exhaustion failures as DriverError", async () => {
    const acquisition = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.as(Database, undefined),
          PostgresScopedLayer({
            acquire: async () => {
              throw new Error("connect failed")
            },
            release: async () => undefined
          })
        )
      )
    )
    expect(acquisition).toBeInstanceOf(DriverError)
    expect(acquisition.message).toContain("connect failed")

    const exhausted = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.as(Database, undefined),
          PostgresPoolLayer({
            connect: async () => {
              throw new Error("pool exhausted")
            }
          })
        )
      )
    )
    expect(exhausted).toBeInstanceOf(DriverError)
    expect(exhausted.message).toContain("pool exhausted")
  })

  it("retains release failures in the Effect cause", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.as(Database, undefined),
        PostgresScopedLayer({
          acquire: async () => pgClient,
          release: async () => {
            throw new Error("release failed")
          }
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("release failed")
  })
})
