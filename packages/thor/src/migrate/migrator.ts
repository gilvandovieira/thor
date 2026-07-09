/**
 * Live migrator (spec §13.7, §13.9, §13.11).
 *
 * Runs migrations against a real `Database`:
 *   - acquires the active dialect's migration lock when one is required,
 *   - wraps each `up`/`down`/`apply` in a transaction (rolled back on failure),
 *   - records applied migrations (with checksum + timing) in the journal table,
 *   - fails hard on checksum mismatch (`check`),
 *   - generates create-only migrations from a schema diff (`generate`),
 *   - detects drift through the active dialect's table introspection query.
 *
 * Provide it with `MigratorLive(config)` over a `Database` layer. The driver must
 * keep a migration transaction on one connection for its full lifetime.
 *
 * @module migrate/migrator
 */
import { Context, Effect, Exit, Layer } from "effect"
import type { DialectStatement } from "../dialect.js"
import { type AnyTable, tableMeta } from "../schema/table.js"
import { Database, type DatabaseService } from "../execution/database.js"
import { IrreversibleMigrationError, MigrationError } from "../errors/index.js"
import type { MigrationOperation, MigrationPlan } from "./migration-ir.js"
import {
  type MigrationDefinition,
  type MigrationStep,
  checksum,
  hashText,
  isSqlStatement
} from "./define-migration.js"
import { type AutoMigrationPolicy, type JournalEntry, guardOperations } from "./journal.js"
import { compilePlan, diffSchema, tableToCreateOp } from "./ddl.js"

/** Configuration captured by a `MigratorService`. */
export interface MigratorConfig {
  /** Ordered list of migrations the runner knows about. */
  readonly migrations?: ReadonlyArray<MigrationDefinition>
  /** Current schema (tables) — used by `generate` and `drift`. */
  readonly schema?: ReadonlyArray<AnyTable>
  /** Policy gating destructive generated operations (default `"safe-only"`). */
  readonly policy?: AutoMigrationPolicy
  /** Journal table name (default `_thor_migrations`). */
  readonly journalTable?: string
}

/** Programmatic migration API (spec §13.7). */
export interface MigratorService {
  /**
   * @returns Applied migrations recorded in the journal, oldest first.
   */
  readonly status: () => Effect.Effect<ReadonlyArray<JournalEntry>, MigrationError>
  /**
   * @returns An Effect validating ordering, uniqueness, and journal checksums.
   */
  readonly check: () => Effect.Effect<void, MigrationError>
  /**
   * @returns An Effect applying pending migrations and yielding new journal entries.
   */
  readonly up: () => Effect.Effect<ReadonlyArray<JournalEntry>, MigrationError>
  /**
   * @returns An Effect rolling back the latest migration when reversible.
   */
  readonly down: () => Effect.Effect<void, MigrationError | IrreversibleMigrationError>
  /**
   * @param name - Human-readable plan name.
   * @param previousTables - Table names in the prior schema snapshot.
   * @returns An Effect yielding a guarded create-only migration plan.
   */
  readonly generate: (
    name: string,
    previousTables?: ReadonlyArray<string>
  ) => Effect.Effect<MigrationPlan, MigrationError>
  /**
   * @param plan - Compiled migration plan to apply.
   * @returns Its persisted journal entry.
   */
  readonly apply: (plan: MigrationPlan) => Effect.Effect<JournalEntry, MigrationError>
  /**
   * @returns Operations needed to reconcile the live database with the configured schema.
   */
  readonly drift: () => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError>
}

/** Effect context tag for the programmatic migration service. */
export class Migrator extends Context.Tag("thor/Migrator")<Migrator, MigratorService>() {}

/**
 * @returns A local wall-clock timestamp suitable for migration identifiers.
 */
const timestamp = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Builds a migrator bound to the ambient `Database` service.
 *
 * @param config - Migration definitions, schema, policy, and journal settings.
 * @returns An Effect yielding a reusable migration service.
 */
export const makeMigrator = (config: MigratorConfig = {}): Effect.Effect<MigratorService, never, Database> =>
  Effect.gen(function* () {
    const db: DatabaseService = yield* Database
    const dialect = db.dialect.migrations
    const JOURNAL = config.journalTable ?? "_thor_migrations"
    const LOCK_KEY = parseInt(hashText(`thor:${JOURNAL}`), 16)
    const migrations = () => [...(config.migrations ?? [])].sort((a, b) => a.id.localeCompare(b.id))

    const toErr = (msg: string) => (cause: { readonly message?: string }) =>
      new MigrationError({ message: `${msg}: ${cause.message ?? String(cause)}`, cause })

    const exec = (sql: string, params: ReadonlyArray<unknown> = []) =>
      db.driver.execute(sql, params).pipe(Effect.mapError(toErr("execute failed")))
    const execScript = (sql: string) =>
      (db.driver.executeScript ? db.driver.executeScript(sql) : db.driver.execute(sql, [])).pipe(
        Effect.mapError(toErr("execute script failed"))
      )
    const queryRows = (sql: string, params: ReadonlyArray<unknown> = []) =>
      db.driver.query(sql, params).pipe(Effect.mapError(toErr("query failed")))
    const runDialectStatement = (statement: DialectStatement) => {
      const params = statement.params ?? []
      if (!statement.resultCheck) return exec(statement.sql, params).pipe(Effect.asVoid)
      return Effect.flatMap(queryRows(statement.sql, params), (rows) =>
        statement.resultCheck!(rows)
          ? Effect.void
          : Effect.fail(new MigrationError({ message: statement.failureMessage ?? "Dialect statement failed" }))
      )
    }

    const ensureJournal = exec(dialect.ensureJournal(JOURNAL))

    const readApplied = queryRows(dialect.readJournal(JOURNAL)).pipe(
      Effect.map((rows): ReadonlyArray<JournalEntry> =>
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          checksum: String(r.checksum),
          appliedAt: r.applied_at instanceof Date ? r.applied_at : new Date(String(r.applied_at)),
          executionTimeMs: Number(r.execution_time_ms)
        }))
      )
    )

    const insertJournal = (entry: JournalEntry) =>
      exec(dialect.insertJournal(JOURNAL), [
        entry.id,
        entry.name,
        entry.checksum,
        entry.appliedAt,
        entry.executionTimeMs
      ])

    const deleteJournal = (id: string) => exec(dialect.deleteJournal(JOURNAL), [id])

    const runStep = (step: MigrationStep): Effect.Effect<void, MigrationError> =>
      isSqlStatement(step) ? execScript(step.sql).pipe(Effect.asVoid) : Effect.provideService(step, Database, db)

    /** Run `body` holding the advisory lock, releasing it no matter what. */
    const withLock = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | MigrationError> => {
      const acquire = dialect.acquireLock(LOCK_KEY)
      const release = dialect.releaseLock(LOCK_KEY)
      if (!acquire) return body
      return Effect.acquireUseRelease(
        runDialectStatement(acquire),
        () => body,
        () => (release ? runDialectStatement(release).pipe(Effect.ignore) : Effect.void)
      )
    }

    /** Run `body` inside a transaction, committing on success and rolling back on any exit failure. */
    const withTx = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | MigrationError> => {
      const { beginTransaction, commitTransaction, rollbackTransaction } = dialect
      if (!beginTransaction || !commitTransaction || !rollbackTransaction) return body
      return Effect.acquireUseRelease(
        exec(beginTransaction),
        () => body,
        (_, exit) => exec(Exit.isSuccess(exit) ? commitTransaction : rollbackTransaction).pipe(Effect.ignore)
      )
    }

    const status: MigratorService["status"] = () => Effect.zipRight(ensureJournal, readApplied)

    const check: MigratorService["check"] = () =>
      Effect.gen(function* () {
        const defs = migrations()
        const seen = new Set<string>()
        for (const m of defs) {
          if (seen.has(m.id)) return yield* Effect.fail(new MigrationError({ message: `duplicate migration id: ${m.id}` }))
          seen.add(m.id)
        }
        yield* ensureJournal
        const applied = yield* readApplied
        const byId = new Map(defs.map((m) => [m.id, m]))
        for (const entry of applied) {
          const def = byId.get(entry.id)
          if (def && checksum(def) !== entry.checksum) {
            return yield* Effect.fail(
              new MigrationError({
                message: `checksum mismatch for "${entry.id}": journal ${entry.checksum} ≠ code ${checksum(def)}`,
                migrationId: entry.id
              })
            )
          }
        }
      })

    const up: MigratorService["up"] = () =>
      Effect.gen(function* () {
        yield* ensureJournal
        const applied = new Set((yield* readApplied).map((e) => e.id))
        const pending = migrations().filter((m) => !applied.has(m.id))
        if (pending.length === 0) return []
        const entries: JournalEntry[] = []
        yield* withLock(
          withTx(
            Effect.gen(function* () {
              for (const m of pending) {
                const start = Date.now()
                yield* runStep(m.up)
                const entry: JournalEntry = {
                  id: m.id,
                  name: m.name,
                  checksum: checksum(m),
                  appliedAt: new Date(),
                  executionTimeMs: Math.max(0, Math.round(Date.now() - start))
                }
                yield* insertJournal(entry)
                entries.push(entry)
              }
            })
          )
        )
        return entries
      })

    const down: MigratorService["down"] = () =>
      Effect.gen(function* () {
        yield* ensureJournal
        const applied = yield* readApplied
        const last = applied[applied.length - 1]
        if (!last) return
        const def = migrations().find((m) => m.id === last.id)
        if (!def) {
          return yield* Effect.fail(
            new MigrationError({ message: `no migration definition for applied id "${last.id}"`, migrationId: last.id })
          )
        }
        if (def.irreversible || !def.down) {
          return yield* Effect.fail(
            new IrreversibleMigrationError({ message: `migration "${def.id}" is irreversible`, migrationId: def.id })
          )
        }
        const downStep = def.down
        yield* withLock(
          withTx(
            Effect.gen(function* () {
              yield* runStep(downStep)
              yield* deleteJournal(def.id)
            })
          )
        )
      })

    const generate: MigratorService["generate"] = (name, previousTables) =>
      Effect.gen(function* () {
        const operations = diffSchema(config.schema ?? [], previousTables ?? [])
        const violations = guardOperations(operations, config.policy ?? "safe-only")
        if (violations.length > 0) {
          return yield* Effect.fail(new MigrationError({ message: violations[0]!.message }))
        }
        return { id: `${timestamp()}_${name}`, name, operations } satisfies MigrationPlan
      })

    const apply: MigratorService["apply"] = (plan) =>
      Effect.gen(function* () {
        yield* ensureJournal
        const ddl = compilePlan(plan, db.dialect)
        const statements = plan.operations.map(dialect.compileOperation)
        const start = Date.now()
        const entry: JournalEntry = {
          id: plan.id,
          name: plan.name,
          checksum: hashText(ddl),
          appliedAt: new Date(),
          executionTimeMs: 0
        }
        const applyBody = Effect.gen(function* () {
          for (const statement of statements) {
            if (statement.trim().length > 0) yield* execScript(statement)
          }
          yield* insertJournal({ ...entry, executionTimeMs: Math.max(0, Math.round(Date.now() - start)) })
        })
        yield* withLock(dialect.transactionalDdl ? withTx(applyBody) : applyBody)
        return { ...entry, executionTimeMs: Math.max(0, Math.round(Date.now() - start)) }
      })

    const drift: MigratorService["drift"] = () =>
      Effect.gen(function* () {
        const rows = yield* queryRows(dialect.listTables)
        const existing = new Set(rows.map((r) => String(r.table_name)))
        return (config.schema ?? []).filter((t) => !existing.has(tableMeta(t).name)).map(tableToCreateOp)
      })

    return { status, check, up, down, generate, apply, drift }
  })

/**
 * @param config - Migration service configuration.
 * @returns A `Migrator` layer requiring `Database`.

 */
export const MigratorLive = (config: MigratorConfig = {}): Layer.Layer<Migrator, never, Database> =>
  Layer.effect(Migrator, makeMigrator(config))
