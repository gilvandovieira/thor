import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { type Dialect, MySQLDialect, sqlite } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect, SQLiteLayer } from "@gilvandovieira/thor/sqlite"
import { makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { Introspector, IntrospectorLive, makeIntrospector } from "@gilvandovieira/thor/introspect"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const supportsNodeSqlite = Number(process.versions.node.split(".")[0]) >= 22

const currentSchema = (driver: FakeDriver, dialect: Dialect) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Introspector, (introspector) => introspector.currentSchema()),
      IntrospectorLive.pipe(Layer.provide(FakeDatabaseLayer(driver, { dialect })))
    )
  )

describe("Epic P1/P3 — Introspector.currentSchema (spec §16.3, §16.4)", () => {
  it("reads a SQLite schema through table_info + foreign_key_list pragmas", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [{ name: "posts" }] }, // sqlite_schema tables
      {
        rows: [
          { name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
          { name: "author_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
          { name: "title", type: "TEXT", notnull: 0, dflt_value: "'untitled'", pk: 0 }
        ]
      }, // pragma table_info(posts)
      { rows: [{ id: 0, seq: 0, table: "authors", from: "author_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE" }] } // pragma foreign_key_list(posts)
    )

    expect(await currentSchema(driver, SQLiteDialect)).toEqual({
      tables: [
        {
          name: "posts",
          columns: [
            { name: "id", type: "TEXT", nullable: false, default: null },
            { name: "author_id", type: "TEXT", nullable: false, default: null },
            { name: "title", type: "TEXT", nullable: true, default: "'untitled'" }
          ],
          primaryKey: ["id"],
          foreignKeys: [{ columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" }]
        }
      ]
    })
    // TABLES + (table_info + foreign_key_list) per table.
    expect(driver.calls.map((call) => call.sql)).toEqual([
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
      'pragma table_info("posts")',
      'pragma foreign_key_list("posts")'
    ])
  })

  it("reads a PostgreSQL schema through information_schema", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [{ table_name: "posts" }] }, // tables
      {
        rows: [
          { table_name: "posts", column_name: "id", data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" },
          { table_name: "posts", column_name: "author_id", data_type: "uuid", is_nullable: "NO", column_default: null }
        ]
      }, // columns
      { rows: [{ table_name: "posts", column_name: "id" }] }, // primary keys
      {
        rows: [
          { table_name: "posts", constraint_name: "posts_author_id_fkey", column_name: "author_id", foreign_table: "authors", foreign_column: "id", delete_rule: "CASCADE", update_rule: "NO ACTION" }
        ]
      } // foreign keys
    )

    expect((await currentSchema(driver, PostgresDialect)).tables[0]).toEqual({
      name: "posts",
      columns: [
        { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
        { name: "author_id", type: "uuid", nullable: false, default: null }
      ],
      primaryKey: ["id"],
      foreignKeys: [{ columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" }]
    })
    expect(driver.calls).toHaveLength(4) // one set-based query per aspect, no N+1
  })

  it("reads a MySQL schema and keeps the full column_type", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [{ table_name: "posts" }] },
      {
        rows: [
          { table_name: "posts", column_name: "id", column_type: "char(36)", is_nullable: "NO", column_default: null },
          { table_name: "posts", column_name: "author_id", column_type: "char(36)", is_nullable: "YES", column_default: null }
        ]
      },
      { rows: [{ table_name: "posts", column_name: "id" }] },
      { rows: [{ table_name: "posts", constraint_name: "fk_author", column_name: "author_id", foreign_table: "authors", foreign_column: "id", delete_rule: "CASCADE", update_rule: "NO ACTION" }] }
    )

    const table = (await currentSchema(driver, MySQLDialect)).tables[0]!
    expect(table.columns[0]).toEqual({ name: "id", type: "char(36)", nullable: false, default: null })
    expect(table.columns[1]!.nullable).toBe(true)
    expect(table.foreignKeys[0]).toEqual({ columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" })
  })

  it("returns an empty schema for a database with no tables", async () => {
    const driver = new FakeDriver().enqueue({ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] })
    expect(await currentSchema(driver, PostgresDialect)).toEqual({ tables: [] })
  })
})

describe.skipIf(!supportsNodeSqlite)("Epic P1/P3 — live SQLite introspection (real pragmas)", () => {
  it("introspects real tables (incl. a column FK) created through the migrator", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const client = new DatabaseSync(":memory:")
    const authors = sqlite.table("authors", {
      id: sqlite.uuid("id").primaryKey(),
      name: sqlite.text("name").notNull()
    })
    const posts = sqlite.table("posts", {
      id: sqlite.uuid("id").primaryKey(),
      authorId: sqlite.uuid("author_id").notNull().references(() => authors.id, { onDelete: "cascade" }),
      title: sqlite.text("title").nullable()
    })

    try {
      const schema = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const migrator = yield* makeMigrator({ schema: [authors, posts] })
            yield* migrator.apply({ id: "1_authors", name: "authors", operations: [tableToCreateOp(authors)] })
            yield* migrator.apply({ id: "2_posts", name: "posts", operations: [tableToCreateOp(posts)] })
            const introspector = yield* makeIntrospector()
            return yield* introspector.currentSchema()
          }),
          SQLiteLayer(client)
        )
      )

      const posts_ = schema.tables.find((table) => table.name === "posts")!
      expect(schema.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["authors", "posts"]))
      expect(posts_.primaryKey).toEqual(["id"])
      expect(posts_.columns.map((column) => column.name)).toEqual(["id", "author_id", "title"])
      expect(posts_.foreignKeys).toEqual([
        { columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" }
      ])
    } finally {
      client.close()
    }
  })
})
