/**
 * Migration journal (spec §13.9) and destructive-op guards (spec §8.3).
 *
 * @module migrate/journal
 */
import { type MigrationOperation, migrationPhase } from "./migration-ir.js"
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

/**
 * Policy controlling which operations a migration run may perform (spec §15.4).
 *
 * - `disabled` — no operations may be applied at all.
 * - `validate-only` — plans are validated but never applied.
 * - `safe-only` — additive/altering operations allowed; destructive ones blocked (default).
 * - `expand-only` — only expand-phase (additive, non-breaking) operations allowed.
 * - `allow-reviewed-destructive` — destructive operations allowed only when the run is explicitly reviewed.
 *
 * `allow-destructive` is a **deprecated** alias that unconditionally allows every
 * operation; prefer `allow-reviewed-destructive` with an explicit review.
 */
export type AutoMigrationPolicy =
  | "disabled"
  | "validate-only"
  | "safe-only"
  | "expand-only"
  | "allow-reviewed-destructive"
  | "allow-destructive"

/** Options refining a policy evaluation (spec §15.4, §15.5). */
export interface GuardOptions {
  /**
   * Whether the run was explicitly reviewed. Required for destructive operations
   * under `allow-reviewed-destructive`.
   */
  readonly reviewed?: boolean
}

/**
 * Migration guard (spec §8.3, §15.4): decide which planned operations a policy
 * permits and return the violations (empty when the plan is allowed).
 *
 * @param operations - Planned migration operations.
 * @param policy - Active migration policy.
 * @param options - Policy refinements (e.g. explicit review).
 * @returns Guard errors describing blocked operations.
 */
export const guardOperations = (
  operations: ReadonlyArray<MigrationOperation>,
  policy: AutoMigrationPolicy,
  options: GuardOptions = {}
): ReadonlyArray<GuardError> => {
  if (policy === "allow-destructive") return []
  const reviewed = options.reviewed ?? false
  const out: GuardError[] = []

  const block = (guard: string, message: string) => out.push(new GuardError({ guard, message }))

  for (const op of operations) {
    if (policy === "disabled") {
      block("migrations-disabled", `Migrations are disabled; operation "${op._tag}" cannot be applied.`)
      continue
    }
    if (policy === "validate-only") {
      block("validate-only", `Policy "validate-only" applies no operations; "${op._tag}" was blocked.`)
      continue
    }
    if (policy === "expand-only" && migrationPhase(op) === "contract") {
      block(
        "non-expand-migration",
        `Operation "${op._tag}" is a contract-phase change and blocked under policy "expand-only".`
      )
      continue
    }
    if (op.destructive && !(policy === "allow-reviewed-destructive" && reviewed)) {
      block(
        "destructive-migration",
        policy === "allow-reviewed-destructive"
          ? `Operation "${op._tag}" is destructive and requires an explicitly reviewed run.`
          : `Operation "${op._tag}" is destructive and blocked under policy "${policy}". Use "allow-reviewed-destructive" with a reviewed run to proceed.`
      )
    }
    if (op._tag === "RawSql" && !(policy === "allow-reviewed-destructive" && reviewed)) {
      block("unchecked-raw-sql", `Raw SQL migration operation is unchecked and blocked under policy "${policy}".`)
    }
  }
  return out
}

/**
 * Manual-migration guard (spec §15.4, P0.4): decide whether the configured
 * policy permits a manual `up`/`down` step whose SQL/Effect body is opaque to
 * Thor, using only the author-declared `safety`/`phase`. This closes the gap
 * where `Migrator.up()`/`down()` executed manual steps without any policy check.
 *
 * @param safety - Author-declared risk class; undefined is unchecked and requires review.
 * @param phase - Author-declared expand/contract phase.
 * @param policy - Active migration policy.
 * @param options - Policy refinements (e.g. explicit review).
 * @returns Guard errors blocking the step (empty when permitted).
 */
export const guardManualMigration = (
  safety: "additive" | "destructive" | undefined,
  phase: "expand" | "contract" | undefined,
  policy: AutoMigrationPolicy,
  options: GuardOptions = {}
): ReadonlyArray<GuardError> => {
  if (policy === "allow-destructive") return []
  const reviewed = options.reviewed ?? false
  const out: GuardError[] = []
  const block = (guard: string, message: string) => out.push(new GuardError({ guard, message }))

  if (policy === "disabled") {
    block("migrations-disabled", `Migrations are disabled; manual migration cannot be applied.`)
    return out
  }
  if (policy === "validate-only") {
    block("validate-only", `Policy "validate-only" applies no operations; manual migration was blocked.`)
    return out
  }

  const destructive = safety === "destructive"
  // Thor cannot prove an arbitrary SQL string is additive. An UNDECLARED safety
  // is therefore treated as "unchecked" — it must not silently pass `safe-only`
  // (Finding 2). Only an explicit `safety: "additive"` is permitted freely.
  const unchecked = safety === undefined
  const needsReview = destructive || unchecked
  const isContract = phase === "contract" || destructive

  if (policy === "expand-only" && (isContract || unchecked)) {
    block(
      "non-expand-migration",
      unchecked
        ? `Manual migration has no declared phase/safety and is blocked under policy "expand-only". Declare phase: "expand", safety: "additive".`
        : `Manual migration is a contract-phase change and blocked under policy "expand-only".`
    )
  }
  if (needsReview && !(policy === "allow-reviewed-destructive" && reviewed)) {
    const reviewedRun = policy === "allow-reviewed-destructive"
    block(
      destructive ? "destructive-migration" : "unchecked-migration",
      destructive
        ? reviewedRun
          ? `Manual migration is declared destructive and requires an explicitly reviewed run.`
          : `Manual migration is declared destructive and blocked under policy "${policy}". Use "allow-reviewed-destructive" with a reviewed run to proceed.`
        : reviewedRun
          ? `Manual migration has no declared safety and requires an explicitly reviewed run; or declare safety: "additive".`
          : `Manual migration has no declared safety and cannot be proven additive; it is blocked under policy "${policy}". Declare safety: "additive"/"destructive", or use a reviewed "allow-reviewed-destructive" run.`
    )
  }
  return out
}
