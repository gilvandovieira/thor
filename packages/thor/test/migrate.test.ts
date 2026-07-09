import { describe, expect, it } from "vitest"
import { pg } from "@gilvandovieira/thor"
import {
  checksum,
  compileOperation,
  compilePlan,
  defineMigration,
  diffSchema,
  guardOperations,
  sql,
  tableToCreateOp,
  type AutoMigrationPolicy,
  type MigrationOperation
} from "@gilvandovieira/thor/migrate"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  displayName: pg.text("display_name").notNull().default("O'Brien"),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  title: pg.text("title").notNull()
})

const safeOperation = {
  destructive: false,
  reversible: true,
  capabilities: []
} as const

describe("migration DDL (spec §13)", () => {
  it("projects table metadata into a complete CreateTable operation", () => {
    expect(tableToCreateOp(users)).toStrictEqual({
      _tag: "CreateTable",
      table: "users",
      columns: [
        { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
        { name: "email", type: "text", nullable: false },
        { name: "display_name", type: "text", nullable: false, default: "'O''Brien'" },
        { name: "created_at", type: "timestamptz", nullable: false, default: "now()" }
      ],
      primaryKey: ["id"],
      ...safeOperation
    })
  })

  it("compiles CreateTable to exact Postgres DDL", () => {
    expect(compileOperation(tableToCreateOp(users))).toBe(`create table "users" (
  "id" uuid not null default gen_random_uuid(),
  "email" text not null,
  "display_name" text not null default 'O''Brien',
  "created_at" timestamptz not null default now(),
  primary key ("id")
);`)
  })

  it.each(
    [
      ["DropTable", { _tag: "DropTable", table: "old_users", destructive: true, reversible: false, capabilities: [] }, 'drop table "old_users";'],
      ["RenameTable", { _tag: "RenameTable", from: "users", to: "accounts", ...safeOperation }, 'alter table "users" rename to "accounts";'],
      [
        "AddColumn",
        {
          _tag: "AddColumn",
          table: "users",
          column: { name: "active", type: "boolean", nullable: false, default: "true" },
          ...safeOperation
        },
        'alter table "users" add column "active" boolean not null default true;'
      ],
      ["DropColumn", { _tag: "DropColumn", table: "users", column: "legacy", destructive: true, reversible: false, capabilities: [] }, 'alter table "users" drop column "legacy";'],
      ["RenameColumn", { _tag: "RenameColumn", table: "users", from: "name", to: "display_name", ...safeOperation }, 'alter table "users" rename column "name" to "display_name";'],
      ["AlterColumnType", { _tag: "AlterColumnType", table: "users", column: "age", to: "bigint", ...safeOperation }, 'alter table "users" alter column "age" type bigint;'],
      ["SetNotNull", { _tag: "SetNotNull", table: "users", column: "email", ...safeOperation }, 'alter table "users" alter column "email" set not null;'],
      ["DropNotNull", { _tag: "DropNotNull", table: "users", column: "nickname", ...safeOperation }, 'alter table "users" alter column "nickname" drop not null;'],
      ["RawSql", { _tag: "RawSql", sql: "create extension pgcrypto", unchecked: true, ...safeOperation }, "create extension pgcrypto;"]
    ] satisfies ReadonlyArray<readonly [string, MigrationOperation, string]>
  )("compiles the %s operation", (_name, operation, expected) => {
    expect(compileOperation(operation)).toBe(expected)
  })

  it("joins a migration plan in operation order", () => {
    const operations: ReadonlyArray<MigrationOperation> = [
      { _tag: "RenameTable", from: "users", to: "accounts", ...safeOperation },
      { _tag: "SetNotNull", table: "accounts", column: "email", ...safeOperation }
    ]

    expect(compilePlan({ id: "plan-1", name: "rename-users", operations })).toBe(
      'alter table "users" rename to "accounts";\n\nalter table "accounts" alter column "email" set not null;'
    )
  })
})

describe("migration planning and guards", () => {
  it("diffs every unknown table while preserving declaration order", () => {
    expect(diffSchema([users, posts], ["users"])).toEqual([tableToCreateOp(posts)])
    expect(diffSchema([users, posts], ["users", "posts"])).toEqual([])
  })

  it.each(["disabled", "validate-only", "safe-only"] satisfies ReadonlyArray<AutoMigrationPolicy>)(
    "blocks destructive and unchecked operations under %s",
    (policy) => {
      const operations: ReadonlyArray<MigrationOperation> = [
        { _tag: "DropTable", table: "users", destructive: true, reversible: false, capabilities: [] },
        { _tag: "RawSql", sql: "vacuum users", unchecked: true, ...safeOperation }
      ]

      expect(guardOperations(operations, policy)).toEqual([
        expect.objectContaining({
          _tag: "GuardError",
          guard: "destructive-migration",
          message: expect.stringContaining(`blocked under policy "${policy}"`)
        }),
        expect.objectContaining({
          _tag: "GuardError",
          guard: "unchecked-raw-sql",
          message: "Raw SQL migration operation is unchecked"
        })
      ])
    }
  )

  it("allows guarded operations under the explicit destructive policy", () => {
    const operations: ReadonlyArray<MigrationOperation> = [
      { _tag: "DropTable", table: "users", destructive: true, reversible: false, capabilities: [] },
      { _tag: "RawSql", sql: "vacuum users", unchecked: true, ...safeOperation }
    ]

    expect(guardOperations(operations, "allow-destructive")).toEqual([])
  })
})

describe("manual migration checksums", () => {
  const migration = defineMigration({
    id: "202607091430_add_users",
    name: "add_users",
    up: sql`create table users (id uuid primary key);`,
    down: sql`drop table users;`
  })

  it("is deterministic and formatted as an eight-character hex hash", () => {
    expect(checksum(migration)).toMatch(/^[0-9a-f]{8}$/)
    expect(checksum({ ...migration })).toBe(checksum(migration))
  })

  it("changes when either migration direction changes", () => {
    const changedUp = { ...migration, up: sql`create table users (id text primary key);` }
    const changedDown = { ...migration, down: sql`drop table users cascade;` }

    expect(checksum(changedUp)).not.toBe(checksum(migration))
    expect(checksum(changedDown)).not.toBe(checksum(migration))
  })

  it("trims and interpolates authored SQL before checksumming", () => {
    const table = "users"

    expect(sql`  drop table ${table};  `).toStrictEqual({ _tag: "SqlStatement", sql: "drop table users;" })
  })
})
