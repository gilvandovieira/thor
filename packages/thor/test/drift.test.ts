import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { pg, sqlite } from "@gilvandovieira/thor"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"
import { makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { type IntrospectedSchema, type IntrospectedTable, detectDrift, makeIntrospector } from "@gilvandovieira/thor/introspect"

const supportsNodeSqlite = Number(process.versions.node.split(".")[0]) >= 22

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull(),
  age: pg.integer("age").nullable()
})

const liveUsers: IntrospectedTable = {
  name: "users",
  columns: [
    { name: "id", type: "uuid", nullable: false, default: null },
    { name: "email", type: "text", nullable: false, default: null },
    { name: "age", type: "integer", nullable: true, default: null }
  ],
  primaryKey: ["id"],
  foreignKeys: []
}
const live = (...tables: IntrospectedTable[]): IntrospectedSchema => ({ tables })

describe("Epic P2 — drift detection (spec §16.5)", () => {
  it("reports in-sync when the database matches the schema", () => {
    const report = detectDrift([users], live(liveUsers))
    expect(report.inSync).toBe(true)
    expect(report.changes).toEqual([])
  })

  it("detects a missing table", () => {
    expect(detectDrift([users], live()).changes).toEqual([
      expect.objectContaining({ _tag: "MissingTable", table: "users" })
    ])
  })

  it("detects an extra table but ignores the migration journal", () => {
    expect(detectDrift([], live(liveUsers)).changes).toEqual([
      expect.objectContaining({ _tag: "ExtraTable", table: "users" })
    ])
    const journal: IntrospectedTable = { name: "_thor_migrations", columns: [], primaryKey: [], foreignKeys: [] }
    expect(detectDrift([], live(journal)).inSync).toBe(true)
  })

  it("detects missing and extra columns", () => {
    const withoutAge: IntrospectedTable = { ...liveUsers, columns: liveUsers.columns.slice(0, 2) }
    expect(detectDrift([users], live(withoutAge)).changes).toEqual([
      expect.objectContaining({ _tag: "MissingColumn", table: "users", column: "age" })
    ])
    const withExtra: IntrospectedTable = {
      ...liveUsers,
      columns: [...liveUsers.columns, { name: "legacy", type: "text", nullable: true, default: null }]
    }
    expect(detectDrift([users], live(withExtra)).changes).toEqual([
      expect.objectContaining({ _tag: "ExtraColumn", table: "users", column: "legacy" })
    ])
  })

  it("detects a nullability change and a primary-key change", () => {
    const emailNullable: IntrospectedTable = {
      ...liveUsers,
      columns: liveUsers.columns.map((c) => (c.name === "email" ? { ...c, nullable: true } : c)),
      primaryKey: ["email"]
    }
    const changes = detectDrift([users], live(emailNullable)).changes
    expect(changes).toContainEqual(expect.objectContaining({ _tag: "NullabilityChanged", column: "email", expectedNullable: false, actualNullable: true }))
    expect(changes).toContainEqual(expect.objectContaining({ _tag: "PrimaryKeyChanged", table: "users", expected: ["id"], actual: ["email"] }))
  })

  it("detects a missing foreign key", () => {
    const authors = pg.table("authors", { id: pg.uuid("id").primaryKey(), name: pg.text("name").notNull() })
    const posts = pg.table("posts", {
      id: pg.uuid("id").primaryKey(),
      authorId: pg.uuid("author_id").notNull().references(() => authors.id)
    })
    const livePosts: IntrospectedTable = {
      name: "posts",
      columns: [
        { name: "id", type: "uuid", nullable: false, default: null },
        { name: "author_id", type: "uuid", nullable: false, default: null }
      ],
      primaryKey: ["id"],
      foreignKeys: []
    }
    expect(detectDrift([posts], live(livePosts)).changes).toEqual([
      expect.objectContaining({ _tag: "MissingForeignKey", table: "posts", columns: ["author_id"] })
    ])
  })
})

describe.skipIf(!supportsNodeSqlite)("Epic P2 — live SQLite drift", () => {
  const authors = sqlite.table("authors", {
    id: sqlite.uuid("id").primaryKey(),
    name: sqlite.text("name").notNull()
  })
  const posts = sqlite.table("posts", {
    id: sqlite.uuid("id").primaryKey(),
    authorId: sqlite.uuid("author_id").notNull().references(() => authors.id)
  })

  it("is in sync right after migrating, and reports drift against a changed schema", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const client = new DatabaseSync(":memory:")
    try {
      const report = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const migrator = yield* makeMigrator({ schema: [authors, posts] })
            yield* migrator.apply({ id: "1_authors", name: "authors", operations: [tableToCreateOp(authors)] })
            yield* migrator.apply({ id: "2_posts", name: "posts", operations: [tableToCreateOp(posts)] })
            const introspector = yield* makeIntrospector()
            const inSync = yield* introspector.drift([authors, posts])
            // A schema-as-code model with an extra expected column the DB lacks.
            const postsV2 = sqlite.table("posts", {
              id: sqlite.uuid("id").primaryKey(),
              authorId: sqlite.uuid("author_id").notNull().references(() => authors.id),
              published: sqlite.boolean("published").notNull()
            })
            const drifted = yield* introspector.drift([authors, postsV2])
            return { inSync, drifted }
          }),
          SQLiteLayer(client)
        )
      )

      expect(report.inSync.inSync).toBe(true)
      expect(report.drifted.changes).toContainEqual(
        expect.objectContaining({ _tag: "MissingColumn", table: "posts", column: "published" })
      )
    } finally {
      client.close()
    }
  })
})
