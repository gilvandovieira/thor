/**
 * Live concurrent journal-upgrade evidence (audit P1.4).
 *
 * The unit suite proves the control flow serializes and de-duplicates the
 * legacy-checksum-column upgrade with a fake harness
 * (`migrator.test.ts` → "serializes concurrent status/dryRun journal upgrades").
 * This lane corroborates it against a real MySQL: two migrators on *separate
 * physical connections* run `status()` concurrently over a legacy
 * `checksum varchar(64)` journal. MySQL's `GET_LOCK` must serialize them so the
 * widening `ALTER TABLE` is applied once, both readers return valid status, and a
 * SHA-256-width checksum then fits.
 *
 * Skipped unless MYSQL_URL is set. See `pnpm e2e`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import mysql2 from "mysql2/promise"
import type { Database } from "@gilvandovieira/thor"
import { type MySQLClient, MySQLLayer } from "@gilvandovieira/thor/mysql"
import { Migrator, MigratorLive, type MigratorService, defineMigration, sql } from "@gilvandovieira/thor/migrate"

const MYSQL_URL = process.env.MYSQL_URL
const JOURNAL = "_thor_migrations"

const migration = defineMigration({
  id: "0001_noop",
  name: "noop",
  safety: "additive",
  phase: "expand",
  downSafety: "additive",
  downPhase: "expand",
  up: sql`select 1`,
  down: sql`select 1`
})

const asClient = (connection: mysql2.Connection): MySQLClient =>
  ({
    query: (sqlText: string, params?: ReadonlyArray<unknown>) => connection.query(sqlText, params as never),
    execute: (sqlText: string, params?: ReadonlyArray<unknown>) => connection.execute(sqlText, params as never)
  }) as unknown as MySQLClient

describe.skipIf(!MYSQL_URL)("live concurrent journal upgrade (P1.4)", () => {
  let admin: mysql2.Connection
  let connA: mysql2.Connection
  let connB: mysql2.Connection

  beforeEach(async () => {
    admin = await mysql2.createConnection(MYSQL_URL!)
    await admin.query(`drop table if exists ${JOURNAL}`)
    // Seed a *legacy* journal: checksum is the pre-sha256 varchar(64) width.
    await admin.query(
      `create table ${JOURNAL} (
        id varchar(255) primary key,
        name varchar(255) not null,
        applied_at timestamp not null default current_timestamp,
        execution_time_ms int not null,
        checksum varchar(64) not null
      )`
    )
    connA = await mysql2.createConnection(MYSQL_URL!)
    connB = await mysql2.createConnection(MYSQL_URL!)
  })

  afterEach(async () => {
    await admin.query(`drop table if exists ${JOURNAL}`)
    await Promise.all([admin.end(), connA.end(), connB.end()])
  })

  const checksumWidth = async (): Promise<number> => {
    const [rows] = await admin.query(
      "select character_maximum_length as len from information_schema.columns where table_schema = database() and table_name = ? and column_name = 'checksum'",
      [JOURNAL]
    )
    return Number((rows as unknown as ReadonlyArray<{ len: number }>)[0].len)
  }

  it("serializes two live migrators widening the legacy checksum column exactly once", async () => {
    expect(await checksumWidth()).toBe(64)

    const config = { migrations: [migration] }
    const appA: Layer.Layer<Migrator | Database> = Layer.provideMerge(MigratorLive(config), MySQLLayer(asClient(connA)))
    const appB: Layer.Layer<Migrator | Database> = Layer.provideMerge(MigratorLive(config), MySQLLayer(asClient(connB)))

    const status = (app: Layer.Layer<Migrator | Database>) =>
      Effect.provide(
        Effect.flatMap(Migrator, (m: MigratorService) => m.status()),
        app
      )

    // Both readers race the upgrade under GET_LOCK; both must succeed.
    const [statusA, statusB] = await Effect.runPromise(Effect.all([status(appA), status(appB)], { concurrency: 2 }))

    expect(statusA).toEqual([])
    expect(statusB).toEqual([])
    // The widening ALTER converged to varchar(255) exactly once and stayed valid.
    expect(await checksumWidth()).toBe(255)

    // A SHA-256-width checksum now fits the upgraded column.
    const wide = `sha256:v1:${"a".repeat(64)}`
    await expect(
      admin.query(`insert into ${JOURNAL} (id, name, applied_at, execution_time_ms, checksum) values (?,?,?,?,?)`, [
        "0001_noop",
        "noop",
        new Date(),
        1,
        wide
      ])
    ).resolves.toBeDefined()
  })
})
