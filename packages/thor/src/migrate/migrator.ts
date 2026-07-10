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
import { Cause, Context, Effect, Exit, Layer } from "effect"
import type { DialectStatement } from "../dialect.js"
import { type AnyTable, tableMeta } from "../schema/table.js"
import { Database, type DatabaseService } from "../execution/database.js"
import { runTransaction } from "../execution/transaction.js"
import { observeLifecycle } from "../observability/index.js"
import { IrreversibleMigrationError, MigrationError, TransactionError } from "../errors/index.js"
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
  /**
   * Whether this run is explicitly reviewed (spec §15.4). Required for
   * destructive operations under the `allow-reviewed-destructive` policy.
   */
  readonly reviewed?: boolean
  /** Journal table name (default `_thor_migrations`). */
  readonly journalTable?: string
}

/** One pending migration previewed by {@link MigratorService.dryRun}. */
export interface DryRunStep {
  /** Migration identifier. */
  readonly id: string
  /** Migration name. */
  readonly name: string
  /** `"sql"` when the up step is a SQL statement, `"effect"` for a backfill/data step. */
  readonly kind: "sql" | "effect"
  /** Compiled SQL for a `"sql"` step; empty for an `"effect"` step (opaque until run). */
  readonly statements: ReadonlyArray<string>
}

/** A reviewable preview of the operations `up()` would apply (spec §15.3). */
export interface DryRunReport {
  /** Pending migrations, in application order, that `up()` would apply. */
  readonly pending: ReadonlyArray<DryRunStep>
}

/**
 * Programmatic migration API (spec §13.7).
 *
 * @stable
 */
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
   * @param previousTables - Table names in the prior schema snapshot.
   * @returns The raw, ungated operations reconciling the schema with the snapshot.
   */
  readonly diff: (
    previousTables?: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError>
  /**
   * @param name - Human-readable plan name.
   * @param previousTables - Table names in the prior schema snapshot.
   * @returns An Effect yielding a policy-guarded migration plan (alias `generate`).
   */
  readonly plan: (
    name: string,
    previousTables?: ReadonlyArray<string>
  ) => Effect.Effect<MigrationPlan, MigrationError>
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
   * Preview the migrations `up()` would apply, without applying them (spec §15.3).
   *
   * @returns A reviewable report of pending migrations and their compiled SQL.
   */
  readonly dryRun: () => Effect.Effect<DryRunReport, MigrationError>
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

/**
 * Effect context tag for the programmatic migration service.
 *
 * @stable
 */
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
    const hasAdvisoryLock = dialect.acquireLock(LOCK_KEY) !== undefined
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

    const migrationDatabase = (migrationId: string, database: DatabaseService = db): DatabaseService => ({
      ...database,
      observabilityContext: { ...database.observabilityContext, migrationId }
    })

    const runStep = (
      step: MigrationStep,
      migrationId: string,
      database: DatabaseService
    ): Effect.Effect<void, MigrationError> =>
      isSqlStatement(step)
        ? execScript(step.sql).pipe(Effect.asVoid)
        : Effect.provideService(step, Database, migrationDatabase(migrationId, database))

    const observeMigration = <A, E>(operation: string, migrationId: string | undefined, effect: Effect.Effect<A, E>) =>
      observeLifecycle(
        db,
        "migration",
        operation,
        effect,
        { ...db.observabilityContext, ...(migrationId ? { migrationId } : {}) }
      )

    const replay = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)

    /** Run `body` holding the advisory lock, releasing it no matter what. */
    const withLock = <A, E>(body: Effect.Effect<A, E>): Effect.Effect<A, E | MigrationError> => {
      const acquire = dialect.acquireLock(LOCK_KEY)
      const release = dialect.releaseLock(LOCK_KEY)
      if (!acquire) return body
      return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* runDialectStatement(acquire)
        const bodyExit = yield* Effect.exit(restore(body))
        const releaseExit = yield* Effect.exit(release ? runDialectStatement(release) : Effect.void)
        if (Exit.isFailure(releaseExit)) {
          return yield* Exit.isFailure(bodyExit)
            ? Effect.failCause(Cause.sequential(bodyExit.cause, releaseExit.cause))
            : Effect.failCause(releaseExit.cause)
        }
        return yield* replay(bodyExit)
      }))
    }

    /** Run `body` inside a transaction, committing on success and rolling back on any exit failure. */
    const withTx = <A, E, R>(
      body: Effect.Effect<A, E, R>,
      database: DatabaseService = db
    ): Effect.Effect<A, E | MigrationError, Exclude<R, Database>> =>
      runTransaction(database, body).pipe(Effect.mapErrorCause((cause) => Cause.map(cause, (error) =>
        error instanceof TransactionError
          ? new MigrationError({ message: error.message, cause: error })
          : error)))

    const validateDefinitions = (defs: ReadonlyArray<MigrationDefinition>): Effect.Effect<void, MigrationError> =>
      Effect.gen(function* () {
        const seen = new Set<string>()
        for (const migration of defs) {
          if (seen.has(migration.id)) {
            return yield* Effect.fail(new MigrationError({ message: `duplicate migration id: ${migration.id}` }))
          }
          seen.add(migration.id)
        }
      })

    const validateApplied = (
      defs: ReadonlyArray<MigrationDefinition>,
      applied: ReadonlyArray<JournalEntry>
    ): Effect.Effect<void, MigrationError> => Effect.gen(function* () {
      const byId = new Map(defs.map((migration) => [migration.id, migration]))
      for (let index = 0; index < applied.length; index++) {
        const entry = applied[index]!
        const def = byId.get(entry.id)
        if (!def) {
          return yield* Effect.fail(new MigrationError({
            message: `unknown applied migration "${entry.id}" has no current definition`,
            migrationId: entry.id
          }))
        }
        const expected = defs[index]
        if (!expected || expected.id !== entry.id) {
          return yield* Effect.fail(new MigrationError({
            message: `migration journal is out of order at "${entry.id}"; expected "${expected?.id ?? "end of journal"}"`,
            migrationId: entry.id
          }))
        }
        const expectedChecksum = checksum(def)
        if (expectedChecksum !== entry.checksum) {
          return yield* Effect.fail(new MigrationError({
            message: `checksum mismatch for "${entry.id}": journal ${entry.checksum} ≠ code ${expectedChecksum}`,
            migrationId: entry.id
          }))
        }
      }
    })

    const status: MigratorService["status"] = () => Effect.zipRight(ensureJournal, readApplied)

    const check: MigratorService["check"] = () => {
      const defs = migrations()
      return withLock(Effect.gen(function* () {
        yield* validateDefinitions(defs)
        yield* ensureJournal
        const applied = yield* readApplied
        yield* validateApplied(defs, applied)
      }))
    }

    const up: MigratorService["up"] = () => {
      const defs = migrations()
      const applyOne = (
        migration: MigrationDefinition,
        database: DatabaseService
      ): Effect.Effect<JournalEntry, MigrationError> =>
        Effect.gen(function* () {
          const start = Date.now()
          yield* runStep(migration.up, migration.id, database)
          const entry: JournalEntry = {
            id: migration.id,
            name: migration.name,
            checksum: checksum(migration),
            appliedAt: new Date(),
            executionTimeMs: Math.max(0, Math.round(Date.now() - start))
          }
          yield* insertJournal(entry)
          return entry
        }).pipe((effect) => observeMigration("apply", migration.id, effect))

      if (hasAdvisoryLock) {
        return withLock(Effect.gen(function* () {
          yield* validateDefinitions(defs)
          yield* ensureJournal
          const appliedEntries = yield* readApplied
          yield* validateApplied(defs, appliedEntries)
          const applied = new Set(appliedEntries.map((entry) => entry.id))
          const pending = defs.filter((migration) => !applied.has(migration.id))
          const entries: JournalEntry[] = []
          for (const migration of pending) {
            const scoped = migrationDatabase(migration.id)
            entries.push(yield* (dialect.transactionalDdl
              ? withTx(Effect.flatMap(Database, (active) => applyOne(migration, active)), scoped)
              : applyOne(migration, scoped)))
          }
          return entries
        }))
      }

      if (!dialect.transactionalDdl) {
        return Effect.fail(new MigrationError({ message: "Dialect has neither a migration lock nor transactional DDL" }))
      }

      // SQLite's BEGIN IMMEDIATE is the lock: plan and apply exactly one step
      // inside each transaction, then repeat and re-read before the next step.
      return Effect.gen(function* () {
        yield* validateDefinitions(defs)
        const entries: JournalEntry[] = []
        while (true) {
          const entry = yield* withTx(Effect.gen(function* () {
            const active = yield* Database
            yield* ensureJournal
            const appliedEntries = yield* readApplied
            yield* validateApplied(defs, appliedEntries)
            const applied = new Set(appliedEntries.map((item) => item.id))
            const next = defs.find((migration) => !applied.has(migration.id))
            return next ? yield* applyOne(next, active) : null
          }))
          if (!entry) break
          entries.push(entry)
        }
        return entries
      })
    }

    const down: MigratorService["down"] = () => {
      const downBody = (transactionalStep: boolean) => Effect.gen(function* () {
        const active = yield* Database
        yield* ensureJournal
        const applied = yield* readApplied
        const defs = migrations()
        yield* validateDefinitions(defs)
        yield* validateApplied(defs, applied)
        const last = applied[applied.length - 1]
        if (!last) return
        const def = defs.find((m) => m.id === last.id)
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
        const rollbackOne = (database: DatabaseService) => observeMigration("rollback", def.id, Effect.gen(function* () {
          yield* runStep(downStep, def.id, database)
          yield* deleteJournal(def.id)
        }))
        yield* (transactionalStep
          ? withTx(Effect.flatMap(Database, rollbackOne), migrationDatabase(def.id, active))
          : rollbackOne(active))
      })
      const effect = hasAdvisoryLock
        ? withLock(Effect.provideService(downBody(dialect.transactionalDdl), Database, db))
        : dialect.transactionalDdl
        ? withTx(downBody(false))
        : Effect.provideService(downBody(false), Database, db)
      return effect
    }

    const policy = config.policy ?? "safe-only"
    const guardOptions = { reviewed: config.reviewed ?? false }

    const diffOps = (previousTables?: ReadonlyArray<string>) =>
      Effect.try({
        try: () => diffSchema(config.schema ?? [], previousTables ?? []),
        catch: (cause) => new MigrationError({ message: `schema cannot be represented as migration DDL: ${String(cause)}`, cause })
      })

    const diff: MigratorService["diff"] = (previousTables) => diffOps(previousTables)

    const plan: MigratorService["plan"] = (name, previousTables) =>
      Effect.gen(function* () {
        const operations = yield* diffOps(previousTables)
        const violations = guardOperations(operations, policy, guardOptions)
        if (violations.length > 0) {
          return yield* Effect.fail(new MigrationError({ message: violations[0]!.message }))
        }
        return { id: `${timestamp()}_${name}`, name, operations } satisfies MigrationPlan
      })

    const generate: MigratorService["generate"] = plan

    const dryRun: MigratorService["dryRun"] = () =>
      Effect.gen(function* () {
        yield* ensureJournal
        const applied = yield* readApplied
        const defs = migrations()
        yield* validateDefinitions(defs)
        const appliedIds = new Set(applied.map((entry) => entry.id))
        const pending = defs
          .filter((migration) => !appliedIds.has(migration.id))
          .map((migration): DryRunStep =>
            isSqlStatement(migration.up)
              ? { id: migration.id, name: migration.name, kind: "sql", statements: [migration.up.sql] }
              : { id: migration.id, name: migration.name, kind: "effect", statements: [] }
          )
        return { pending } satisfies DryRunReport
      })

    const apply: MigratorService["apply"] = (plan) => {
      const violations = guardOperations(plan.operations, policy, guardOptions)
      if (violations.length > 0) {
        return Effect.fail(new MigrationError({ message: violations[0]!.message, migrationId: plan.id }))
      }
      const applyLocked = (transactionalStep: boolean) => Effect.gen(function* () {
        yield* ensureJournal
        const applied = yield* readApplied
        if (applied.some((entry) => entry.id === plan.id)) {
          return yield* Effect.fail(new MigrationError({
            message: `migration plan "${plan.id}" is already applied`,
            migrationId: plan.id
          }))
        }
        const { ddl, statements } = yield* Effect.try({
          try: () => ({
            ddl: compilePlan(plan, db.dialect),
            statements: plan.operations.map(dialect.compileOperation)
          }),
          catch: (cause) => new MigrationError({
            message: `migration plan "${plan.id}" contains unsupported DDL: ${String(cause)}`,
            migrationId: plan.id,
            cause
          })
        })
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
        yield* (transactionalStep ? withTx(applyBody, migrationDatabase(plan.id)) : applyBody)
        return { ...entry, executionTimeMs: Math.max(0, Math.round(Date.now() - start)) }
      })
      const effect = hasAdvisoryLock
        ? withLock(applyLocked(dialect.transactionalDdl))
        : dialect.transactionalDdl ? withTx(applyLocked(false), migrationDatabase(plan.id)) : applyLocked(false)
      return observeMigration("apply", plan.id, effect)
    }

    const drift: MigratorService["drift"] = () =>
      observeMigration("drift", undefined, Effect.gen(function* () {
        const rows = yield* queryRows(dialect.listTables)
        const existing = new Set(rows.map((r) => String(r.table_name)))
        return yield* Effect.try({
          try: () => (config.schema ?? []).filter((t) => !existing.has(tableMeta(t).name)).map(tableToCreateOp),
          catch: (cause) => new MigrationError({ message: `schema cannot be represented as migration DDL: ${String(cause)}`, cause })
        })
      }))

    return { status, check, up, down, diff, plan, generate, dryRun, apply, drift }
  })

/**
 * @param config - Migration service configuration.
 * @returns A `Migrator` layer requiring `Database`.

 */
export const MigratorLive = (config: MigratorConfig = {}): Layer.Layer<Migrator, never, Database> =>
  Layer.effect(Migrator, makeMigrator(config))
