import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Database, DriverError, type Driver, type RawRow } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { defineMigration, legacyChecksum, makeMigrator, sql, type JournalEntry } from "@gilvandovieira/thor/migrate"
import type { MigrationDialect } from "../src/dialect.js"

interface HarnessOptions {
  readonly transactionalDdl?: boolean
  readonly failCommit?: boolean
  readonly failRollback?: boolean
  readonly loseLock?: boolean
  readonly legacyJournal?: boolean
  readonly journal?: ReadonlyArray<JournalEntry>
}

const harness = (options: HarnessOptions = {}) => {
  const journal = [...(options.journal ?? [])]
  const calls: string[] = []
  let locked = false
  let checksumWidth = options.legacyJournal ? 64 : 255
  const waiters: Array<() => void> = []

  const acquire = (): Effect.Effect<ReadonlyArray<RawRow>, DriverError> =>
    Effect.async((resume) => {
      const enter = () => {
        locked = true
        calls.push("lock")
        resume(Effect.succeed([{ acquired: 1 }]))
      }
      if (locked) waiters.push(enter)
      else enter()
    })

  const release = (): ReadonlyArray<RawRow> => {
    calls.push("unlock")
    locked = false
    waiters.shift()?.()
    return [{ released: options.loseLock ? 0 : 1 }]
  }

  const migrationDialect: MigrationDialect = {
    compileOperation: () => "ddl",
    ensureJournal: () => "ensure",
    upgradeJournal: () => ({
      probe: { sql: "probe" },
      needsUpgrade: (rows) => Number(rows[0]?.len) < 255,
      upgrade: "upgrade"
    }),
    readJournal: () => "read",
    insertJournal: () => "insert",
    deleteJournal: () => "delete",
    acquireLock: () => ({
      sql: "lock",
      resultCheck: (rows) => rows[0]?.acquired === 1,
      failureMessage: "lock acquisition failed"
    }),
    releaseLock: () => ({
      sql: "unlock",
      resultCheck: (rows) => rows[0]?.released === 1,
      failureMessage: "migration lock was lost"
    }),
    transactionalDdl: options.transactionalDdl ?? true,
    beginTransaction: "begin",
    commitTransaction: "commit",
    rollbackTransaction: "rollback",
    listTables: "tables"
  }

  const failure = (message: string) => new DriverError({ message })
  const driver: Driver = {
    runtime: { adapter: "migration-test", required: [] },
    query: (statement) =>
      Effect.suspend(() => {
        if (statement === "lock") return acquire()
        if (statement === "unlock") return Effect.succeed(release())
        if (statement === "probe") {
          calls.push("probe")
          return Effect.succeed([{ len: checksumWidth }])
        }
        if (statement === "read") {
          calls.push("read")
          return Effect.succeed(
            journal.map((entry) => ({
              id: entry.id,
              name: entry.name,
              checksum: entry.checksum,
              applied_at: entry.appliedAt,
              execution_time_ms: entry.executionTimeMs
            }))
          )
        }
        if (statement === "tables") return Effect.succeed([])
        return Effect.succeed([])
      }),
    execute: (statement, params) =>
      Effect.suspend(() => {
        calls.push(statement)
        if (statement === "commit" && options.failCommit) return Effect.fail(failure("commit failed"))
        if (statement === "rollback" && options.failRollback) return Effect.fail(failure("rollback failed"))
        if (statement === "upgrade") checksumWidth = 255
        if (statement === "insert") {
          journal.push({
            id: String(params[0]),
            name: String(params[1]),
            checksum: String(params[2]),
            appliedAt: params[3] as Date,
            executionTimeMs: Number(params[4])
          })
        }
        if (statement === "delete") {
          const index = journal.findIndex((entry) => entry.id === params[0])
          if (index >= 0) journal.splice(index, 1)
        }
        return Effect.succeed({ rowCount: 0 })
      }),
    executeScript: (statement) =>
      Effect.suspend(() => {
        calls.push(`script:${statement}`)
        return statement === "fail" ? Effect.fail(failure("script failed")) : Effect.succeed({ rowCount: 0 })
      })
  }

  const dialect = { ...PostgresDialect, migrations: migrationDialect }
  const layer = Layer.succeed(Database, {
    dialect,
    driver,
    allowEmulation: false,
    preparedStatements: false
  })
  const service = (migrations: NonNullable<Parameters<typeof makeMigrator>[0]>["migrations"]) =>
    Effect.runPromise(Effect.provide(makeMigrator({ migrations }), layer))

  return { calls, journal, service }
}

const migration = defineMigration({
  id: "0001_first",
  name: "first",
  safety: "additive",
  downSafety: "destructive",
  up: sql`first`,
  down: sql`undo first`
})

describe("migration concurrency and failure invariants", () => {
  it("re-reads pending migrations under the lock so racers cannot double-apply", async () => {
    const test = harness()
    const first = await test.service([migration])
    const second = await test.service([migration])

    const [a, b] = await Effect.runPromise(Effect.all([first.up(), second.up()], { concurrency: 2 }))
    expect([a.length, b.length].sort(), JSON.stringify(test.calls)).toEqual([0, 1])
    expect(test.calls.filter((call) => call === "script:first")).toHaveLength(1)
    expect(test.journal.map((entry) => entry.id)).toEqual([migration.id])
  })

  it("serializes concurrent status/dryRun journal upgrades without recursively locking", async () => {
    const test = harness({ legacyJournal: true })
    const first = await test.service([migration])
    const second = await test.service([migration])

    const [status, report] = await Effect.runPromise(Effect.all([first.status(), second.dryRun()], { concurrency: 2 }))

    expect(status).toEqual([])
    expect(report.pending.map((entry) => entry.id)).toEqual([migration.id])
    expect(test.calls.filter((call) => call === "upgrade")).toHaveLength(1)
    expect(test.calls.filter((call) => call === "lock")).toHaveLength(2)
    expect(test.calls.filter((call) => call === "unlock")).toHaveLength(2)
  })

  it("surfaces commit failure and retains both body/rollback failures", async () => {
    const commit = harness({ failCommit: true })
    const commitService = await commit.service([migration])
    const commitExit = await Effect.runPromiseExit(commitService.up())
    expect(Exit.isFailure(commitExit)).toBe(true)
    expect(JSON.stringify(commitExit)).toContain("commit failed")

    const rollback = harness({ failRollback: true })
    const bad = defineMigration({ id: "0001_bad", name: "bad", safety: "additive", up: sql`fail` })
    const rollbackService = await rollback.service([bad])
    const rollbackExit = await Effect.runPromiseExit(rollbackService.up())
    expect(JSON.stringify(rollbackExit)).toContain("script failed")
    expect(JSON.stringify(rollbackExit)).toContain("rollback failed")
  })

  it("rejects unknown/out-of-order journal state and propagates lock loss", async () => {
    const unknownEntry: JournalEntry = {
      id: "0009_unknown",
      name: "unknown",
      checksum: "deadbeef",
      appliedAt: new Date(),
      executionTimeMs: 0
    }
    const unknown = harness({ journal: [unknownEntry] })
    const unknownService = await unknown.service([migration])
    const unknownExit = await Effect.runPromiseExit(unknownService.check())
    expect(JSON.stringify(unknownExit)).toContain("unknown applied migration")

    const lost = harness({ loseLock: true })
    const lostService = await lost.service([migration])
    const lostExit = await Effect.runPromiseExit(lostService.up())
    expect(JSON.stringify(lostExit)).toContain("migration lock was lost")
  })

  it("accepts legacy checksums and rejects unknown versioned algorithms clearly", async () => {
    const base = {
      id: migration.id,
      name: migration.name,
      appliedAt: new Date(),
      executionTimeMs: 0
    }
    const legacy = harness({ journal: [{ ...base, checksum: legacyChecksum(migration) }] })
    const legacyService = await legacy.service([migration])
    await expect(Effect.runPromise(legacyService.check())).resolves.toBeUndefined()
    expect(legacy.journal[0]?.checksum).toBe(legacyChecksum(migration))

    const unknown = harness({ journal: [{ ...base, checksum: "sha512:v1:deadbeef" }] })
    const unknownService = await unknown.service([migration])
    const exit = await Effect.runPromiseExit(unknownService.check())
    expect(JSON.stringify(exit)).toContain("unknown checksum algorithm")
  })

  it("journals completed non-transactional migrations before a later MySQL-style DDL failure", async () => {
    const test = harness({ transactionalDdl: false })
    const bad = defineMigration({ id: "0002_bad", name: "bad", safety: "additive", up: sql`fail` })
    const service = await test.service([migration, bad])
    const exit = await Effect.runPromiseExit(service.up())

    expect(Exit.isFailure(exit)).toBe(true)
    expect(test.calls).not.toContain("begin")
    expect(test.journal.map((entry) => entry.id)).toEqual([migration.id])
  })

  it("rolls back and releases the lock when a migration is interrupted", async () => {
    const test = harness()
    const interrupted = defineMigration({
      id: "0001_wait",
      name: "wait",
      revision: "1",
      safety: "additive",
      up: Effect.never
    })
    const service = await test.service([interrupted])
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(service.up())
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(test.calls).toContain("rollback")
    expect(test.calls).toContain("unlock")
  })

  it("redo rolls back and reapplies under one lock and one transaction", async () => {
    const reversible = defineMigration({
      id: "0001_reversible",
      name: "reversible",
      safety: "additive",
      downSafety: "additive",
      up: sql`apply`,
      down: sql`revert`
    })
    const entry: JournalEntry = {
      id: reversible.id,
      name: reversible.name,
      checksum: legacyChecksum(reversible),
      appliedAt: new Date(0),
      executionTimeMs: 0
    }
    const test = harness({ journal: [entry] })
    const service = await test.service([reversible])

    const reapplied = await Effect.runPromise(service.redo())

    expect(reapplied?.id).toBe(reversible.id)
    expect(test.calls.filter((call) => call === "lock")).toHaveLength(1)
    expect(test.calls.filter((call) => call === "unlock")).toHaveLength(1)
    expect(test.calls.filter((call) => call === "begin")).toHaveLength(1)
    expect(test.calls.filter((call) => call === "commit")).toHaveLength(1)
    expect(test.calls.indexOf("script:revert")).toBeLessThan(test.calls.indexOf("delete"))
    expect(test.calls.indexOf("delete")).toBeLessThan(test.calls.indexOf("script:apply"))
    expect(test.calls.indexOf("script:apply")).toBeLessThan(test.calls.indexOf("insert"))
    expect(test.journal.map((item) => item.id)).toEqual([reversible.id])
  })
})
