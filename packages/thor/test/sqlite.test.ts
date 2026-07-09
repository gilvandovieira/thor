import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { db, eq, sqlite } from "@gilvandovieira/thor"
import { makeMigrator, tableToCreateOp } from "@gilvandovieira/thor/migrate"
import { SQLiteLayer } from "@gilvandovieira/thor/sqlite"

const supportsNodeSqlite = Number(process.versions.node.split(".")[0]) >= 22

describe.skipIf(!supportsNodeSqlite)("SQLite in-memory integration", () => {
  it("migrates, writes, returns, filters, and decodes through the SQLite dialect", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const client = new DatabaseSync(":memory:")
    const users = sqlite.table("users", {
      id: sqlite.uuid("id").primaryKey().defaultRandom(),
      email: sqlite.text("email").notNull(),
      active: sqlite.boolean("active").notNull().default(true),
      profile: sqlite.json("profile", Schema.Struct({ role: Schema.String })).notNull(),
      createdAt: sqlite.timestamp("created_at").notNull().defaultNow()
    })

    try {
      const layer = SQLiteLayer(client)
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const migrator = yield* makeMigrator({ schema: [users] })
            yield* migrator.apply({
              id: "20260709_create_users",
              name: "create_users",
              operations: [tableToCreateOp(users)]
            })
            const inserted = yield* db
              .insert(users)
              .values({ email: "ada@example.com", profile: { role: "admin" } })
              .returning({
                id: users.id,
                active: users.active,
                profile: users.profile,
                createdAt: users.createdAt
              })
              .one()
            const selected = yield* db
              .select({ id: users.id, email: users.email, active: users.active, profile: users.profile })
              .from(users)
              .where(eq(users.id, inserted.id))
              .one()
            const status = yield* migrator.status()
            const drift = yield* migrator.drift()
            return { inserted, selected, status, drift }
          }),
          layer
        )
      )

      expect(result.inserted.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.inserted.active).toBe(true)
      expect(result.inserted.profile).toStrictEqual({ role: "admin" })
      expect(result.inserted.createdAt).toBeInstanceOf(Date)
      expect(result.selected).toStrictEqual({
        id: result.inserted.id,
        email: "ada@example.com",
        active: true,
        profile: { role: "admin" }
      })
      expect(result.status).toHaveLength(1)
      expect(result.status[0]).toMatchObject({ id: "20260709_create_users", name: "create_users" })
      expect(result.drift).toEqual([])
    } finally {
      client.close()
    }
  })
})
