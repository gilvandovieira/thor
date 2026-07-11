import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Database } from "@gilvandovieira/thor"
import { MigrationError, defineMigration, makeMigrator, rawSql } from "@gilvandovieira/thor/migrate"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"

const supportsNodeSqlite = Number(process.versions.node.split(".")[0]) >= 22

describe.skipIf(!supportsNodeSqlite)("redo atomicity on SQLite", () => {
  it("restores schema and journal when reapply fails after rollback", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const client = new DatabaseSync(":memory:")
    let applications = 0
    const up = Effect.suspend(() => {
      applications++
      return applications === 1
        ? rawSql`create table redo_guard (id integer primary key)`
        : Effect.fail(new MigrationError({ message: "adversarial reapply failure" }))
    })
    const migration = defineMigration({
      id: "0001_redo_guard",
      name: "redo_guard",
      revision: "1",
      safety: "additive",
      downSafety: "additive",
      up,
      down: rawSql`drop table redo_guard`
    })

    try {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const migrator = yield* makeMigrator({ migrations: [migration] })
            yield* migrator.up()
            const redoExit = yield* Effect.exit(migrator.redo())
            const status = yield* migrator.status()
            const database = yield* Database
            const tableRows = yield* database.driver.query(
              "select name from sqlite_master where type = 'table' and name = 'redo_guard'",
              []
            )
            return { redoExit, status, tableRows }
          }),
          SQLiteLayer(client)
        )
      )

      expect(result.redoExit._tag).toBe("Failure")
      expect(result.status.map((entry) => entry.id)).toEqual([migration.id])
      expect(result.tableRows).toEqual([{ name: "redo_guard" }])
    } finally {
      client.close()
    }
  })
})
