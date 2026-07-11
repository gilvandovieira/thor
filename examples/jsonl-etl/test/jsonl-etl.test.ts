import { Effect, Exit } from "effect"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ensureInputFile, InputRowError, readInput } from "../src/data.js"
import { makeDatabaseLayer, makeTelemetrySummary } from "../src/database.js"
import { runEtl } from "../src/etl.js"

const temporaryDirectories: string[] = []

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "thor-jsonl-etl-"))
  temporaryDirectories.push(path)
  return path
}

const executeEtl = (inputPath: string, databasePath: string) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(runEtl(inputPath), makeDatabaseLayer(databasePath, makeTelemetrySummary())))
  )

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("JSONL ETL example", () => {
  it("preserves source line numbers when blank lines are skipped", async () => {
    const directory = await temporaryDirectory()
    const inputPath = join(directory, "events.jsonl")
    await Effect.runPromise(ensureInputFile(inputPath, 1))
    const valid = (await readFile(inputPath, "utf8")).trim()
    await writeFile(inputPath, `${valid}\n\n{\n`, "utf8")

    const error = await Effect.runPromise(Effect.flip(readInput(inputPath)))
    expect(error).toBeInstanceOf(InputRowError)
    expect(error.line).toBe(3)
  })

  it("runs twice with checked migrations and stable aggregate reconciliation", async () => {
    const directory = await temporaryDirectory()
    const inputPath = join(directory, "events.jsonl")
    const databasePath = join(directory, "etl.sqlite")
    await Effect.runPromise(ensureInputFile(inputPath, 100))

    const first = await executeEtl(inputPath, databasePath)
    const database = new DatabaseSync(databasePath)
    database.exec(`insert into daily_metrics
      (id, source_id, day, event_type, event_count, high_value_count, gross_usd, refreshed_at)
      values ('obsolete', 'store-na', '1999-01-01', 'view', 1, 0, 0, '2026-01-01T00:00:00.000Z')`)
    database.close()
    const second = await executeEtl(inputPath, databasePath)

    expect(first.loaded).toBe(100)
    expect(second.loaded).toBe(100)
    expect(second.metricGroups).toBe(first.metricGroups)
    expect(second.migrationStatus).toHaveLength(1)
    expect(second.migrationStatus[0]?.checksum).toBe(first.migrationStatus[0]?.checksum)
    expect(second.drift).toEqual({ inSync: true, changes: [] })

    const reconciled = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(reconciled.prepare("select count(*) as count from daily_metrics").get()).toEqual({
        count: first.metricGroups
      })
      expect(reconciled.prepare("select count(*) as count from daily_metrics where id = 'obsolete'").get()).toEqual({
        count: 0
      })
    } finally {
      reconciled.close()
    }
  })

  it("marks an import failed when input decoding fails", async () => {
    const directory = await temporaryDirectory()
    const inputPath = join(directory, "events.jsonl")
    const databasePath = join(directory, "etl.sqlite")
    await writeFile(inputPath, "{not-json}\n", "utf8")

    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.provide(runEtl(inputPath), makeDatabaseLayer(databasePath, makeTelemetrySummary())))
    )
    expect(Exit.isFailure(exit)).toBe(true)

    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(database.prepare("select status, rows_read, rows_loaded from import_runs").get()).toEqual({
        status: "failed",
        rows_read: 1,
        rows_loaded: 0
      })
    } finally {
      database.close()
    }
  })
})
