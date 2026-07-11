import { cp, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

describe("two physical Thor package copies", () => {
  let temporary = ""
  let coreA: any
  let coreB: any
  let migrateA: any
  let migrateB: any
  let routineA: any

  beforeAll(async () => {
    temporary = await mkdtemp(join(process.cwd(), ".thor-two-copy-"))
    const source = join(process.cwd(), "packages/thor/dist")
    const first = join(temporary, "copy-a")
    const second = join(temporary, "copy-b")
    await Promise.all([
      cp(source, first, { recursive: true }),
      cp(source, second, { recursive: true }),
      cp(join(process.cwd(), "packages/thor/src"), join(temporary, "src"), { recursive: true })
    ])
    const load = (root: string, path: string) => import(pathToFileURL(join(root, path)).href)
    ;[coreA, coreB, migrateA, migrateB, routineA] = await Promise.all([
      load(first, "index.js"),
      load(second, "index.js"),
      load(first, "migrate/index.js"),
      load(second, "migrate/index.js"),
      load(first, "routine/index.js")
    ])
  })

  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })

  it("interoperates through the versioned same-realm authenticity protocol", () => {
    const unsafe = coreA.unsafeSql("CURRENT_TIMESTAMP")
    expect(coreB.sql`${unsafe}`._tag).toBe("RawExpr")

    const statement = migrateA.sql`select 1`
    expect(migrateB.isSqlStatement(statement)).toBe(true)

    const table = coreA.pg.table("copy_users", {
      id: coreA.pg.text("id").primaryKey(),
      score: coreA.pg.integer("score")
    })
    const value = coreA.param("id", Schema.String)
    const predicate = coreA.eq(table.id, value)
    const compiled = coreB.db.select({ id: table.id }).from(table).where(predicate).toSql()
    expect(compiled.sql).toBe('SELECT "copy_users"."id" AS "id" FROM "copy_users" WHERE "copy_users"."id" = $1')

    const doubled = routineA.defineFunction("double_score", {
      args: [{ dataType: "integer", codec: Schema.Number }],
      returns: { dataType: "integer", codec: Schema.Number }
    })
    expect(
      coreB.db
        .select({ value: doubled(table.score) })
        .from(table)
        .toSql().sql
    ).toContain('"double_score"')

    const operation = {
      _tag: "DropTable",
      table: "copy_users",
      destructive: true,
      reversible: false,
      capabilities: []
    }
    expect(coreB.PostgresDialect.migrations.compileOperation(operation)).toBe('drop table "copy_users";')
  })

  it("still rejects plain data for authenticated unsafe and migration values", () => {
    expect(() => coreB.sql`${{ _tag: "UnsafeSql", sql: "drop table users" }}`).toThrow(TypeError)
    expect(migrateB.isSqlStatement({ _tag: "SqlStatement", sql: "drop table users" })).toBe(false)
  })
})
