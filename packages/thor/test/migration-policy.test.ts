import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Database, type Driver, DriverError, type RawRow } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import {
  type AutoMigrationPolicy,
  defineMigration,
  makeMigrator,
  sql,
  type JournalEntry
} from "@gilvandovieira/thor/migrate"
import type { MigrationDialect } from "../src/dialect.js"

/**
 * P0.4 — the configured policy must govern the manual migrations actually
 * executed by up()/down(), not just generated plans.
 */
const harness = () => {
  const scripts: string[] = []
  const journal: JournalEntry[] = []

  const migrationDialect: MigrationDialect = {
    compileOperation: () => "ddl",
    ensureJournal: () => "ensure",
    readJournal: () => "read",
    insertJournal: () => "insert",
    deleteJournal: () => "delete",
    acquireLock: () => ({ sql: "lock", resultCheck: (r) => r[0]?.acquired === 1, failureMessage: "lock failed" }),
    releaseLock: () => ({ sql: "unlock", resultCheck: (r) => r[0]?.released === 1, failureMessage: "unlock failed" }),
    transactionalDdl: true,
    beginTransaction: "begin",
    commitTransaction: "commit",
    rollbackTransaction: "rollback",
    listTables: "tables"
  }

  const driver: Driver = {
    runtime: { adapter: "policy-test", required: [] },
    query: (statement) =>
      Effect.suspend((): Effect.Effect<ReadonlyArray<RawRow>, DriverError> => {
        if (statement === "lock") return Effect.succeed([{ acquired: 1 }])
        if (statement === "unlock") return Effect.succeed([{ released: 1 }])
        if (statement === "read")
          return Effect.succeed(
            journal.map((e) => ({
              id: e.id,
              name: e.name,
              checksum: e.checksum,
              applied_at: e.appliedAt,
              execution_time_ms: e.executionTimeMs
            }))
          )
        return Effect.succeed([])
      }),
    execute: (statement, params) =>
      Effect.sync(() => {
        if (statement === "insert")
          journal.push({
            id: String(params[0]),
            name: String(params[1]),
            checksum: String(params[2]),
            appliedAt: params[3] as Date,
            executionTimeMs: Number(params[4])
          })
        if (statement === "delete") {
          const i = journal.findIndex((e) => e.id === params[0])
          if (i >= 0) journal.splice(i, 1)
        }
        return { rowCount: 0 }
      }),
    executeScript: (statement) =>
      Effect.sync(() => {
        scripts.push(statement)
        return { rowCount: 0 }
      })
  }

  const dialect = { ...PostgresDialect, migrations: migrationDialect }
  const layer = Layer.succeed(Database, { dialect, driver, allowEmulation: false, preparedStatements: false })

  const runUp = (
    migrations: NonNullable<Parameters<typeof makeMigrator>[0]>["migrations"],
    policy: AutoMigrationPolicy,
    reviewed = false
  ) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(makeMigrator({ migrations, policy, reviewed }), (m) => m.up()),
        layer
      )
    )

  return { scripts, journal, runUp }
}

const destructive = defineMigration({
  id: "0001_drop",
  name: "drop_users",
  safety: "destructive",
  up: sql`drop table users`
})

const additive = defineMigration({
  id: "0001_add",
  name: "add_users",
  safety: "additive",
  up: sql`create table users (id int)`
})

describe("migration policy governs manual execution (P0.4)", () => {
  it("blocks a destructive manual migration under safe-only before SQL runs", async () => {
    const h = harness()
    const exit = await h.runUp([destructive], "safe-only")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.scripts).toEqual([]) // no destructive SQL reached the driver
    expect(h.journal).toEqual([]) // nothing journaled
  })

  it("blocks the same destructive migration under unreviewed allow-reviewed-destructive", async () => {
    const h = harness()
    const exit = await h.runUp([destructive], "allow-reviewed-destructive", false)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.scripts).toEqual([])
  })

  it("allows the destructive migration under a reviewed allow-reviewed-destructive run", async () => {
    const h = harness()
    const exit = await h.runUp([destructive], "allow-reviewed-destructive", true)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.scripts).toEqual(["drop table users"])
  })

  it("allows an additive manual migration under safe-only", async () => {
    const h = harness()
    const exit = await h.runUp([additive], "safe-only")
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.scripts).toEqual(["create table users (id int)"])
  })

  it("blocks every manual migration under disabled and validate-only", async () => {
    for (const policy of ["disabled", "validate-only"] as const) {
      const h = harness()
      const exit = await h.runUp([additive], policy)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(h.scripts).toEqual([])
    }
  })

  it("blocks a contract-phase manual migration under expand-only", async () => {
    const h = harness()
    const contract = defineMigration({
      id: "0001_c",
      name: "c",
      phase: "contract",
      up: sql`alter table users drop column x`
    })
    const exit = await h.runUp([contract], "expand-only")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(h.scripts).toEqual([])
  })
})
