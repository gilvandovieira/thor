/**
 * Migration journal (spec §13.9) and destructive-op guards (spec §8.3).
 *
 * @module migrate/journal
 */
import type { MigrationOperation } from "./migration-ir.js"
import type { Dialect } from "../dialect.js"
import { GuardError } from "../errors/index.js"

/** PostgreSQL compatibility DDL. Prefer `journalTableSqlFor` for new code. */
export const journalTableSql = `create table if not exists _thor_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null,
  execution_time_ms integer not null
);`

/**
 * @param dialect - Target database dialect.
 * @param table - Journal table name.
 * @returns Journal creation DDL.
 */
export const journalTableSqlFor = (dialect: Dialect, table = "_thor_migrations"): string =>
  dialect.migrations.ensureJournal(table)

/** Persisted record of an applied migration. */
export interface JournalEntry {
  readonly id: string
  readonly name: string
  readonly checksum: string
  readonly appliedAt: Date
  readonly executionTimeMs: number
}

/** Policy controlling which operations a migration run may perform (spec §13.8). */
export type AutoMigrationPolicy = "disabled" | "validate-only" | "safe-only" | "allow-destructive"

/**
 * Migration guard (spec §8.3): under a non-destructive policy, block destructive
 * operations. Returns the violations (empty if the plan is allowed).
 *
 * @param operations - Planned migration operations.
 * @param policy - Destructive-operation policy.
 * @returns Guard errors describing blocked operations.
 */
export const guardOperations = (
  operations: ReadonlyArray<MigrationOperation>,
  policy: AutoMigrationPolicy
): ReadonlyArray<GuardError> => {
  if (policy === "allow-destructive") return []
  const out: GuardError[] = []
  for (const op of operations) {
    if (op.destructive) {
      out.push(
        new GuardError({
          guard: "destructive-migration",
          message: `Operation "${op._tag}" is destructive and blocked under policy "${policy}". Set policy to "allow-destructive" to proceed.`
        })
      )
    }
    if (op._tag === "RawSql") {
      out.push(
        new GuardError({ guard: "unchecked-raw-sql", message: "Raw SQL migration operation is unchecked" })
      )
    }
  }
  return out
}
