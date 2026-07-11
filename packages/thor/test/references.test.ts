import { describe, expect, it } from "vitest"
import { pg } from "@gilvandovieira/thor"
import { type AnyTable, tableMeta } from "@gilvandovieira/thor/schema"
import { tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"

const authors = pg.table("authors", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  name: pg.text("name").notNull()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  authorId: pg
    .uuid("author_id")
    .notNull()
    .references(() => authors.id, { onDelete: "cascade" }),
  title: pg.text("title").notNull()
})

// Self-reference exercises lazy thunk resolution: `comments` is referenced from
// within its own definition. A self-referencing table needs an explicit type
// annotation to break TypeScript's circular-inference (as with other ORMs).
const comments: AnyTable = pg.table("comments", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  parentId: pg
    .uuid("parent_id")
    .nullable()
    .references(() => comments.id)
})

describe("Epic Q1 — column.references() FK metadata (spec §13.2)", () => {
  it("captures a column-level foreign key in table metadata", () => {
    expect(tableMeta(posts).foreignKeys).toEqual([
      { columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" }
    ])
  })

  it("resolves self-references lazily", () => {
    expect(tableMeta(comments).foreignKeys).toEqual([
      { columns: ["parent_id"], references: { table: "comments", columns: ["id"] } }
    ])
  })

  it("merges column-level references after table-level foreign keys", () => {
    const t = pg.table(
      "t",
      {
        a: pg
          .uuid("a")
          .notNull()
          .references(() => authors.id),
        b: pg.uuid("b").notNull()
      },
      { foreignKeys: [{ columns: ["b"], references: { table: "authors", columns: ["id"] } }] }
    )
    expect(tableMeta(t).foreignKeys.map((fk) => fk.columns[0])).toEqual(["b", "a"])
  })

  it("does not alter the column's insert/select nullability", () => {
    // .references() is pure metadata; authorId stays a required, non-null column.
    expect(tableMeta(posts).columns.authorId!.def.notNull).toBe(true)
  })

  it("flows into migration DDL through tableToCreateOp", () => {
    const op = tableToCreateOp(posts)
    expect(op.foreignKeys).toEqual([
      { columns: ["author_id"], references: { table: "authors", columns: ["id"] }, onDelete: "cascade" }
    ])
    expect(PostgresDialect.migrations.compileOperation(op)).toContain(
      `foreign key ("author_id") references "authors" ("id") on delete cascade`
    )
  })
})
