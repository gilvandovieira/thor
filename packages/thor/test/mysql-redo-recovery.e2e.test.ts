import { Effect, Exit, Layer } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import mysql2 from "mysql2/promise"
import { type Database, MigrationError } from "@gilvandovieira/thor"
import { type MySQLClient, MySQLLayer } from "@gilvandovieira/thor/mysql"
import { Migrator, MigratorLive, defineMigration, rawSql } from "@gilvandovieira/thor/migrate"

const MYSQL_URL = process.env.MYSQL_URL

describe.skipIf(!MYSQL_URL)("live MySQL redo recovery", () => {
  let connection: mysql2.Connection
  let client: MySQLClient

  beforeAll(async () => {
    connection = await mysql2.createConnection(MYSQL_URL!)
    client = {
      query: (sql: string, params?: ReadonlyArray<unknown>) => connection.query(sql, params as never),
      execute: (sql: string, params?: ReadonlyArray<unknown>) => connection.execute(sql, params as never)
    } as unknown as MySQLClient
  })

  afterAll(() => connection.end())

  beforeEach(async () => {
    await connection.query("drop table if exists mysql_redo_probe")
    await connection.query("drop table if exists _thor_migrations")
  })

  it("documents the partial state after reapply failure and supports an idempotent rerun", async () => {
    let applications = 0
    const migration = defineMigration({
      id: "0001_mysql_redo_probe",
      name: "mysql_redo_probe",
      revision: "1",
      safety: "additive",
      phase: "expand",
      downSafety: "destructive",
      downPhase: "contract",
      up: Effect.suspend(() => {
        applications++
        const create = rawSql`create table if not exists mysql_redo_probe (id integer primary key)`
        return applications === 2
          ? Effect.zipRight(
              create,
              Effect.fail(new MigrationError({ message: "mysql reapply failed", migrationId: "0001_mysql_redo_probe" }))
            )
          : create
      }),
      down: rawSql`drop table mysql_redo_probe`
    })
    const app = Layer.provideMerge(
      MigratorLive({ migrations: [migration], policy: "allow-reviewed-destructive" }),
      MySQLLayer(client)
    )
    const use = <A, E>(effect: Effect.Effect<A, E, Migrator | Database>) => Effect.provide(effect, app)

    await Effect.runPromise(use(Effect.flatMap(Migrator, (migrator) => migrator.up())))
    const redoExit = await Effect.runPromiseExit(
      use(Effect.flatMap(Migrator, (migrator) => migrator.redo({ reviewed: true })))
    )
    expect(Exit.isFailure(redoExit)).toBe(true)

    const [tables] = await connection.query("show tables like 'mysql_redo_probe'")
    const [journal] = await connection.query("select id from _thor_migrations where id = '0001_mysql_redo_probe'")
    expect((tables as unknown[]).length).toBe(1)
    expect((journal as unknown[]).length).toBe(0)

    const recovered = await Effect.runPromise(use(Effect.flatMap(Migrator, (migrator) => migrator.up())))
    expect(recovered.map((entry) => entry.id)).toEqual(["0001_mysql_redo_probe"])
  })
})
