import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Database, type Driver, MySQLDialect, type RawRow, db, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import {
  type JournalEntry,
  type MigrationOperation,
  backfill,
  defineMigration,
  guardOperations,
  isExpandOperation,
  makeMigrator,
  migrationPhase,
  planExpandContract,
  sql,
  unsafeSql
} from "@gilvandovieira/thor/migrate"
import type { MigrationDialect } from "../src/dialect.js"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  name: pg.text("name").notNull()
})
const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  userId: pg.uuid("user_id").notNull()
})

// --- operation fixtures ------------------------------------------------------
const dropTable: MigrationOperation = {
  _tag: "DropTable",
  table: "old",
  destructive: true,
  reversible: false,
  capabilities: []
}
const createTable: MigrationOperation = {
  _tag: "CreateTable",
  table: "t",
  columns: [],
  primaryKey: [],
  destructive: false,
  reversible: true,
  capabilities: []
}
const addNullable: MigrationOperation = {
  _tag: "AddColumn",
  table: "users",
  column: { name: "nick", type: "text", nullable: true },
  destructive: false,
  reversible: true,
  capabilities: []
}
const addRequired: MigrationOperation = {
  _tag: "AddColumn",
  table: "users",
  column: { name: "nick", type: "text", nullable: false },
  destructive: false,
  reversible: true,
  capabilities: []
}
const setNotNull: MigrationOperation = {
  _tag: "SetNotNull",
  table: "users",
  column: "nick",
  destructive: false,
  reversible: true,
  capabilities: []
}
const rawSql: MigrationOperation = {
  _tag: "RawSql",
  sql: "vacuum",
  unchecked: true,
  destructive: false,
  reversible: false,
  capabilities: []
}

describe("Epic O3 — expand/contract classification (spec §15.5)", () => {
  it("classifies additive, non-breaking operations as expand", () => {
    expect(migrationPhase(createTable)).toBe("expand")
    expect(migrationPhase(addNullable)).toBe("expand")
    expect(
      migrationPhase({
        _tag: "DropNotNull",
        table: "users",
        column: "name",
        destructive: false,
        reversible: true,
        capabilities: []
      })
    ).toBe("expand")
    expect(isExpandOperation(addNullable)).toBe(true)
  })

  it("classifies destructive/breaking operations as contract", () => {
    expect(migrationPhase(dropTable)).toBe("contract")
    expect(migrationPhase(addRequired)).toBe("contract") // required column breaks old inserts
    expect(migrationPhase(setNotNull)).toBe("contract")
    expect(
      migrationPhase({
        _tag: "AddColumn",
        table: "users",
        column: { name: "u", type: "text", nullable: true, unique: true },
        destructive: false,
        reversible: true,
        capabilities: []
      })
    ).toBe("contract")
  })
})

describe("Epic O3 — migration policies (spec §15.4)", () => {
  it("safe-only blocks destructive and unchecked operations", () => {
    const errors = guardOperations([dropTable, rawSql], "safe-only")
    expect(errors.map((e) => e.guard)).toEqual(["destructive-migration", "unchecked-raw-sql"])
  })

  it("expand-only allows expand steps and blocks contract steps", () => {
    expect(guardOperations([addNullable], "expand-only")).toEqual([])
    const errors = guardOperations([addRequired, setNotNull], "expand-only")
    expect(errors.map((e) => e.guard)).toEqual(["non-expand-migration", "non-expand-migration"])
  })

  it("allow-reviewed-destructive gates destructive ops on an explicit review", () => {
    expect(guardOperations([dropTable], "allow-reviewed-destructive", { reviewed: false })).toEqual([
      expect.objectContaining({ guard: "destructive-migration", message: expect.stringContaining("reviewed run") })
    ])
    expect(guardOperations([dropTable, rawSql], "allow-reviewed-destructive", { reviewed: true })).toEqual([])
  })

  it("disabled and validate-only block every operation", () => {
    expect(guardOperations([createTable], "disabled")).toEqual([
      expect.objectContaining({ guard: "migrations-disabled" })
    ])
    expect(guardOperations([createTable], "validate-only")).toEqual([
      expect.objectContaining({ guard: "validate-only" })
    ])
  })

  it("the deprecated allow-destructive alias permits everything", () => {
    expect(guardOperations([dropTable, rawSql], "allow-destructive")).toEqual([])
  })
})

describe("Epic O2 — expand/contract generator (spec §15.5)", () => {
  const plans = planExpandContract("rename_name_to_display", {
    table: "users",
    add: { name: "display_name", type: "text", nullable: false },
    backfillSql: "update users set display_name = name",
    dropColumn: "name"
  })

  it("emits ordered add → backfill → require → contract plans", () => {
    expect(plans.map((p) => p.id)).toEqual([
      "rename_name_to_display_1_expand",
      "rename_name_to_display_2_backfill",
      "rename_name_to_display_3_require",
      "rename_name_to_display_4_contract"
    ])
    // The added column is forced nullable in the expand phase, no matter the input.
    expect(plans[0]!.operations[0]).toMatchObject({
      _tag: "AddColumn",
      column: { name: "display_name", nullable: true }
    })
    expect(plans[1]!.operations[0]).toMatchObject({ _tag: "RawSql", sql: "update users set display_name = name" })
    expect(plans[2]!.operations[0]).toMatchObject({ _tag: "SetNotNull", column: "display_name" })
    expect(plans[3]!.operations[0]).toMatchObject({ _tag: "DropColumn", column: "name", destructive: true })
  })

  it("keeps the contract (drop) step blocked unless the run is a reviewed destructive one", () => {
    const drop = plans[3]!.operations
    expect(guardOperations(drop, "safe-only")).not.toEqual([])
    expect(guardOperations(drop, "expand-only")).not.toEqual([])
    expect(guardOperations(drop, "allow-reviewed-destructive", { reviewed: true })).toEqual([])
  })
})

describe("Epic O4 — backfill helper (spec §15.1)", () => {
  it("runs a typed data effect as a migration step and yields void", async () => {
    const driver = new FakeDriver().enqueue({ rowCount: 2 })
    const result = await Effect.runPromise(
      Effect.provide(backfill(db.update(users).set({ name: "backfilled" }).run()), FakeDatabaseLayer(driver))
    )
    expect(result).toBeUndefined()
    expect(driver.calls[0]!.sql.toLowerCase()).toContain("update")
  })
})

// --- live-service harness (O1, O5) ------------------------------------------
interface HarnessOptions {
  readonly transactionalDdl?: boolean
  readonly journal?: ReadonlyArray<JournalEntry>
}
const harness = (options: HarnessOptions = {}) => {
  const journal = [...(options.journal ?? [])]
  const calls: string[] = []
  const scripts: string[] = []
  const migrationDialect: MigrationDialect = {
    compileOperation: (op) => PostgresDialect.migrations.compileOperation(op),
    ensureJournal: () => "ensure",
    readJournal: () => "read",
    insertJournal: () => "insert",
    deleteJournal: () => "delete",
    acquireLock: () => undefined,
    releaseLock: () => undefined,
    transactionalDdl: options.transactionalDdl ?? true,
    beginTransaction: "begin",
    commitTransaction: "commit",
    rollbackTransaction: "rollback",
    listTables: "tables"
  }
  const driver: Driver = {
    runtime: { adapter: "o-test", required: [] },
    query: (statement): Effect.Effect<ReadonlyArray<RawRow>, never> =>
      Effect.sync(() => {
        calls.push(statement)
        if (statement === "read") {
          return journal.map((e) => ({
            id: e.id,
            name: e.name,
            checksum: e.checksum,
            applied_at: e.appliedAt,
            execution_time_ms: e.executionTimeMs
          }))
        }
        return []
      }),
    execute: (statement, params) =>
      Effect.sync(() => {
        calls.push(statement)
        if (statement === "insert") {
          journal.push({
            id: String(params[0]),
            name: String(params[1]),
            checksum: String(params[2]),
            appliedAt: params[3] as Date,
            executionTimeMs: Number(params[4])
          })
        }
        return { rowCount: 0 }
      }),
    executeScript: (statement) =>
      Effect.sync(() => {
        scripts.push(statement)
        calls.push("script")
        return { rowCount: 0 }
      })
  }
  const layer = Layer.succeed(Database, {
    dialect: { ...PostgresDialect, migrations: migrationDialect },
    driver,
    allowEmulation: false,
    preparedStatements: false
  })
  const run = <A, E>(effect: Effect.Effect<A, E, Database>) => Effect.runPromise(Effect.provide(effect, layer))
  return { journal, calls, scripts, run }
}

describe("Epic O1 — diff, plan, dryRun (spec §15.3)", () => {
  it("diff returns the raw create operations for absent tables", async () => {
    const h = harness()
    const ops = await h.run(Effect.flatMap(makeMigrator({ schema: [users, posts] }), (m) => m.diff(["users"])))
    expect(ops.map((o) => (o as { table: string }).table)).toEqual(["posts"])
  })

  it("plan produces a guarded, reviewable migration plan", async () => {
    const h = harness()
    const plan = await h.run(
      Effect.flatMap(makeMigrator({ schema: [users, posts] }), (m) => m.plan("add_posts", ["users"]))
    )
    expect(plan.name).toBe("add_posts")
    expect(plan.operations.map((o) => o._tag)).toEqual(["CreateTable"])
  })

  it("dryRun previews pending migrations and their SQL without applying", async () => {
    const first = defineMigration({ id: "0001_a", name: "a", up: sql`create table a ()` })
    const second = defineMigration({ id: "0002_b", name: "b", up: sql`create table b ()` })
    const h = harness({
      journal: [{ id: "0001_a", name: "a", checksum: "x", appliedAt: new Date(), executionTimeMs: 0 }]
    })
    const report = await h.run(Effect.flatMap(makeMigrator({ migrations: [first, second] }), (m) => m.dryRun()))
    expect(report.pending).toEqual([{ id: "0002_b", name: "b", kind: "sql", statements: ["create table b ()"] }])
    // Nothing was written: the journal insert was never issued.
    expect(h.calls).not.toContain("insert")
  })

  it("apply is policy-guarded: a destructive plan is blocked under safe-only", async () => {
    const h = harness()
    const exit = await h.run(
      Effect.flip(
        Effect.flatMap(makeMigrator({ policy: "safe-only" }), (m) =>
          m.apply({ id: "9001_drop", name: "drop", operations: [dropTable] })
        )
      )
    )
    expect(exit).toMatchObject({ _tag: "MigrationError" })
    expect(h.calls).not.toContain("script") // never reached the driver
  })

  it("apply proceeds for a reviewed destructive run", async () => {
    const h = harness()
    const entry = await h.run(
      Effect.flatMap(makeMigrator({ policy: "allow-reviewed-destructive" }), (m) =>
        m.apply({ id: "9002_drop", name: "drop", operations: [dropTable] }, { reviewed: true })
      )
    )
    expect(entry.id).toBe("9002_drop")
    expect(h.scripts.join("\n")).toContain("drop table")
  })
})

describe("Epic O6 — routine/function DDL (spec §15.1, §14)", () => {
  const createFn: MigrationOperation = {
    _tag: "CreateRoutine",
    routine: "function",
    name: "add_one",
    args: [{ name: "n", type: unsafeSql("integer") }],
    returns: unsafeSql("integer"),
    language: unsafeSql("sql"),
    body: unsafeSql("select n + 1"),
    replace: true,
    destructive: false,
    reversible: true,
    capabilities: []
  }
  const createProc: MigrationOperation = {
    _tag: "CreateRoutine",
    routine: "procedure",
    name: "do_it",
    args: [{ name: "x", type: unsafeSql("integer") }],
    language: unsafeSql("sql"),
    body: unsafeSql("begin end"),
    destructive: false,
    reversible: true,
    capabilities: []
  }
  const dropFn: MigrationOperation = {
    _tag: "DropRoutine",
    routine: "function",
    name: "add_one",
    args: [{ type: unsafeSql("integer") }],
    ifExists: true,
    destructive: true,
    reversible: false,
    capabilities: []
  }

  it("classifies create as expand and drop as contract", () => {
    expect(migrationPhase(createFn)).toBe("expand")
    expect(migrationPhase(dropFn)).toBe("contract")
    // A dropped routine is destructive, so safe-only blocks it.
    expect(guardOperations([dropFn], "safe-only").map((e) => e.guard)).toEqual(["destructive-migration"])
  })

  it("compiles PostgreSQL function/procedure DDL", () => {
    expect(PostgresDialect.migrations.compileOperation(createFn)).toBe(
      `create or replace function "add_one"("n" integer) returns integer language sql as $$select n + 1$$;`
    )
    expect(PostgresDialect.migrations.compileOperation(createProc)).toBe(
      `create procedure "do_it"("x" integer) language sql as $$begin end$$;`
    )
    expect(PostgresDialect.migrations.compileOperation(dropFn)).toBe(`drop function if exists "add_one"(integer);`)
  })

  it("compiles MySQL routine DDL (no OR REPLACE, no arg list on drop)", () => {
    expect(MySQLDialect.migrations.compileOperation(createFn)).toBe(
      "create function `add_one`(`n` integer) returns integer select n + 1"
    )
    expect(MySQLDialect.migrations.compileOperation(dropFn)).toBe("drop function if exists `add_one`;")
  })

  it("rejects stored routines on SQLite before the driver", () => {
    expect(() => SQLiteDialect.migrations.compileOperation(createFn)).toThrow(/does not support stored function/)
    expect(() => SQLiteDialect.migrations.compileOperation(dropFn)).toThrow(/does not support stored function/)
  })
})

describe("Epic O5 — transactional-DDL awareness (spec §15.1)", () => {
  const plan = { id: "9100_create", name: "create", operations: [createTable] }

  it("wraps application in a transaction where the dialect supports transactional DDL", async () => {
    const h = harness({ transactionalDdl: true })
    await h.run(Effect.flatMap(makeMigrator(), (m) => m.apply(plan)))
    expect(h.calls).toContain("begin")
    expect(h.calls).toContain("commit")
  })

  it("applies without a transaction where the dialect does not support it", async () => {
    const h = harness({ transactionalDdl: false })
    await h.run(Effect.flatMap(makeMigrator(), (m) => m.apply(plan)))
    expect(h.calls).not.toContain("begin")
    expect(h.calls).not.toContain("commit")
    expect(h.scripts.join("\n")).toContain("create table")
  })
})
