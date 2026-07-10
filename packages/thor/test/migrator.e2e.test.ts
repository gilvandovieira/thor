/**
 * End-to-end migrator tests against a real Postgres (spec §14.10, §14.11).
 *
 * Skipped unless DATABASE_URL is set. Bring the database up with:
 *   docker compose up -d --wait
 *   DATABASE_URL=postgres://thor:thor@localhost:5433/thor pnpm test:e2e
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import pg from "pg"
import { Database, db, eq, param, pg as t } from "@gilvandovieira/thor"
import { PostgresLayer } from "@gilvandovieira/thor/postgres"
import {
  Migrator,
  MigratorLive,
  type MigratorService,
  defineMigration,
  rawSql,
  sql
} from "@gilvandovieira/thor/migrate"
import { Schema } from "effect"

const DATABASE_URL = process.env.DATABASE_URL

const users = t.table("users", {
  id: t.uuid("id").primaryKey().defaultRandom(),
  email: t.text("email").notNull().unique(),
  name: t.text("name").nullable()
})
const posts = t.table("posts", {
  id: t.uuid("id").primaryKey().defaultRandom(),
  title: t.text("title").notNull()
})

// Ordered migrations covering SQL steps and an Effect (rawSql) backfill step.
const m1 = defineMigration({
  id: "0001_create_users",
  name: "create_users",
  up: sql`create table users (id uuid primary key default gen_random_uuid(), email text not null unique, name text);`,
  down: sql`drop table users;`
})
const m2 = defineMigration({
  id: "0002_add_created_at",
  name: "add_created_at",
  up: sql`alter table users add column created_at timestamptz not null default now();`,
  down: sql`alter table users drop column created_at;`
})
const m3 = defineMigration({
  id: "0003_backfill_names",
  name: "backfill_names",
  revision: "1",
  up: rawSql`update users set name = email where name is null`,
  down: rawSql`select 1`
})

describe.skipIf(!DATABASE_URL)("live migrator e2e (spec §13)", () => {
  let client: pg.Client
  let app: Layer.Layer<Migrator | Database>

  const config = { migrations: [m1, m2, m3], schema: [users, posts], policy: "safe-only" as const }

  const mig = <A, E>(f: (m: MigratorService) => Effect.Effect<A, E>) => Effect.flatMap(Migrator, f)
  const run = <A, E>(eff: Effect.Effect<A, E, Migrator | Database>) => Effect.runPromise(Effect.provide(eff, app))
  const runExit = <A, E>(eff: Effect.Effect<A, E, Migrator | Database>) =>
    Effect.runPromiseExit(Effect.provide(eff, app))
  const q = async (sqlText: string, params: unknown[] = []) => (await client.query(sqlText, params)).rows

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL })
    await client.connect()
    app = Layer.provideMerge(MigratorLive(config), PostgresLayer(client))
  })

  afterAll(async () => {
    await client?.end()
  })

  beforeEach(async () => {
    // Fully reset the schema (and journal) so each test is isolated.
    await client.query("drop schema public cascade; create schema public;")
  })

  it("up() applies all pending migrations, runs SQL + Effect steps, and journals them", async () => {
    const entries = await run(mig((m) => m.up()))
    expect(entries.map((e) => e.id)).toEqual(["0001_create_users", "0002_add_created_at", "0003_backfill_names"])
    for (const e of entries) expect(e.checksum).toMatch(/^[0-9a-f]{8}$/)

    // m2 added created_at; its presence proves the SQL step ran.
    const cols = await q(
      "select column_name from information_schema.columns where table_name = 'users' order by column_name"
    )
    expect(cols.map((c) => c.column_name)).toContain("created_at")

    // Journal reflects all three, oldest first.
    const status = await run(mig((m) => m.status()))
    expect(status.map((s) => s.id)).toEqual(["0001_create_users", "0002_add_created_at", "0003_backfill_names"])

    // check() passes on freshly-applied migrations.
    await run(mig((m) => m.check()))
  })

  it("up() is idempotent — a second run applies nothing", async () => {
    await run(mig((m) => m.up()))
    const second = await run(mig((m) => m.up()))
    expect(second).toEqual([])
  })

  it("down() rolls back the last migration and un-journals it", async () => {
    await run(mig((m) => m.up()))
    await run(mig((m) => m.down())) // rolls back m3 (no-op)
    await run(mig((m) => m.down())) // rolls back m2 (drop created_at)

    const cols = await q("select column_name from information_schema.columns where table_name = 'users'")
    expect(cols.map((c) => c.column_name)).not.toContain("created_at")

    const status = await run(mig((m) => m.status()))
    expect(status.map((s) => s.id)).toEqual(["0001_create_users"])
  })

  it("a failing migration rolls the whole transaction back (spec §14.11)", async () => {
    const bad = defineMigration({
      id: "0001_bad",
      name: "bad",
      up: sql`create table ok (id int); create table ok (id int);` // duplicate -> fails
    })
    const badApp = Layer.provideMerge(MigratorLive({ migrations: [bad] }), PostgresLayer(client))
    const exit = await Effect.runPromiseExit(Effect.provide(mig((m) => m.up()), badApp))
    expect(Exit.isFailure(exit)).toBe(true)

    // Neither the table nor a journal row survived the rollback.
    const tables = await q(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('ok', '_thor_migrations')"
    )
    const journal = tables.find((t2) => t2.table_name === "_thor_migrations")
    if (journal) {
      const rows = await q("select * from _thor_migrations where id = '0001_bad'")
      expect(rows).toEqual([])
    }
    expect(tables.map((t2) => t2.table_name)).not.toContain("ok")
  })

  it("check() fails hard on a journal checksum mismatch (spec §13.9)", async () => {
    await run(mig((m) => m.up()))
    await client.query("update _thor_migrations set checksum = 'deadbeef' where id = '0002_add_created_at'")
    const exit = await runExit(mig((m) => m.check()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify((exit as Exit.Failure<never, unknown>).cause)).toMatch(/checksum mismatch/)
  })

  it("generate() diffs the schema and apply() creates the tables + journals the plan", async () => {
    const plan = await run(mig((m) => m.generate("init_schema", [])))
    expect(plan.operations.map((o) => o._tag)).toEqual(["CreateTable", "CreateTable"])

    const entry = await run(mig((m) => m.apply(plan)))
    expect(entry.id).toBe(plan.id)

    const tables = await q(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
    )
    expect(tables.map((r) => r.table_name)).toEqual(["_thor_migrations", "posts", "users"])

    // The plan is recorded in the journal.
    const status = await run(mig((m) => m.status()))
    expect(status.map((s) => s.id)).toContain(plan.id)
  })

  it("drift() reports tables that exist in code but not in the database", async () => {
    // Create only `users`, leaving `posts` missing from the DB.
    await client.query("create table users (id uuid primary key, email text not null, name text);")
    const drift = await run(mig((m) => m.drift()))
    expect(drift.map((o) => (o._tag === "CreateTable" ? o.table : o._tag))).toEqual(["posts"])
  })

  it("runs a real query through the full stack (schema -> compile -> execute -> decode)", async () => {
    await client.query(
      "create table users (id uuid primary key default gen_random_uuid(), email text not null unique, name text);"
    )
    const inserted = await run(
      db.insert(users).values({ email: "lucas@example.com", name: "Lucas" }).returning({ id: users.id, email: users.email }).one()
    )
    expect(inserted.email).toBe("lucas@example.com")

    const found = await run(
      db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, param("email", Schema.String)))
        .one({ email: "lucas@example.com" })
    )
    expect(found.name).toBe("Lucas")
    expect(found.id).toBe(inserted.id)
  })
})
