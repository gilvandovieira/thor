/**
 * Migration authoring (spec §13.3–13.4). A migration's `up`/`down` may be a raw
 * SQL statement (`sql`) or an `Effect` for data backfills (`rawSql`, or any
 * `Effect<void, MigrationError, Database>`).
 *
 * @module migrate/define-migration
 */
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { MigrationError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import type { UnsafeSqlNode } from "../ir/query-ir.js"

/** A raw SQL statement (from the `sql` tagged template). */
export interface SqlStatement {
  readonly _tag: "SqlStatement"
  readonly sql: string
}

/**
 * The two supported migration step forms. Effect steps run inside the migration
 * transaction with the `Database` service available (use `rawSql` for SQL).
 */
export type MigrationStep = SqlStatement | Effect.Effect<void, MigrationError, Database>

/**
 * The declared risk class of a manual migration (spec §15.4, P0.4). Thor cannot
 * infer safety from opaque `sql`/`rawSql` text, so authors declare it: an
 * `"additive"` migration passes `safe-only`; a `"destructive"` migration is
 * blocked under `safe-only`/`expand-only` and requires an explicitly reviewed
 * `allow-reviewed-destructive` run. When omitted, the migration is treated as
 * author-trusted additive (see the migration policy docs for the trade-off).
 */
export type MigrationSafety = "additive" | "destructive"

/** The expand/contract phase a manual migration belongs to (spec §15.5). */
export type MigrationPhase = "expand" | "contract"

interface MigrationDefinitionBase {
  /** Stable, sortable migration identifier. */
  readonly id: string
  /** Human-readable migration name. */
  readonly name: string
  /** Explicitly marks the migration as impossible to roll back. */
  readonly irreversible?: boolean
  /**
   * Declared risk class governing which policy permits this manual migration
   * (spec §15.4). Defaults to author-trusted additive when omitted.
   */
  readonly safety?: MigrationSafety
  /** Declared expand/contract phase, enforced under the `expand-only` policy. */
  readonly phase?: MigrationPhase
}

/**
 * User-authored migration; Effect steps require an explicit revision fingerprint.
 *
 * @stable
 */
export type MigrationDefinition =
  | (MigrationDefinitionBase & {
      readonly up: SqlStatement
      readonly down?: SqlStatement
      readonly revision?: string
    })
  | (MigrationDefinitionBase & {
      readonly up: MigrationStep
      readonly down?: MigrationStep
      /** Changed whenever an Effect/backfill implementation changes. */
      readonly revision: string
    })

/**
 * @stable
 * @param definition - Complete migration definition.
 * @returns The same definition with preserved inference.
 */
export const defineMigration = (definition: MigrationDefinition): MigrationDefinition => definition

/**
 * @param step - Migration step to inspect.
 * @returns Whether the step is a tagged SQL statement.
 */
export const isSqlStatement = (step: MigrationStep): step is SqlStatement =>
  typeof step === "object" && step !== null && "_tag" in step && (step as SqlStatement)._tag === "SqlStatement"

/**
 * Authors a trusted SQL migration step.
 *
 * @param strings - Static template chunks.
 * @param values - Dynamic text explicitly marked with `unsafeSql`.
 * @returns A trimmed tagged SQL statement.
 * @remarks Migration templates are not parameterized; ordinary interpolation is rejected.
 */
export const sql = (strings: TemplateStringsArray, ...values: ReadonlyArray<UnsafeSqlNode>): SqlStatement => {
  let out = ""
  strings.forEach((chunk, i) => {
    out += chunk
    if (i < values.length) {
      const value = values[i]
      if (value?._tag !== "UnsafeSql") {
        throw new TypeError("Migration SQL interpolation requires unsafeSql(...)")
      }
      out += value.sql
    }
  })
  return { _tag: "SqlStatement", sql: out.trim() }
}

/**
 * Effect migration step that runs a raw SQL statement inside the migration
 * transaction (spec §13.4). Dynamic text requires `unsafeSql` — migrations
 * take no bound params.
 *
 * @param strings - Static template chunks.
 * @param values - Dynamic text explicitly marked with `unsafeSql`.
 * @returns An Effect executing the script through the active `Database` driver.
 */
export const rawSql = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<UnsafeSqlNode>
): Effect.Effect<void, MigrationError, Database> => {
  let text = ""
  strings.forEach((chunk, i) => {
    text += chunk
    if (i < values.length) {
      const value = values[i]
      if (value?._tag !== "UnsafeSql") {
        throw new TypeError("Migration rawSql interpolation requires unsafeSql(...)")
      }
      text += value.sql
    }
  })
  const statement = text.trim()
  return Effect.flatMap(Database, (db) =>
    (db.driver.executeScript ? db.driver.executeScript(statement) : db.driver.execute(statement, [])).pipe(
      Effect.mapError((cause) => new MigrationError({ message: `rawSql failed: ${cause.message}`, cause })),
      Effect.asVoid
    )
  )
}

/**
 * Wrap a typed data effect (e.g. `db.update(...).set(...).run()`) as a migration
 * backfill step (spec §15.1). The effect runs inside the migration transaction
 * with the `Database` service available; its result is discarded and any tagged
 * failure is normalized to a `MigrationError`. Pair it with an explicit
 * `revision` on the migration so the checksum tracks implementation changes.
 *
 * ```ts
 * defineMigration({
 *   id: "003_backfill_display_name",
 *   name: "backfill display_name",
 *   revision: "1",
 *   up: backfill(db.update(users).set({ displayName: users.name }).run())
 * })
 * ```
 *
 * @typeParam E - Tagged error of the wrapped effect.
 * @param effect - Data effect requiring the `Database` service.
 * @returns A migration step that runs the effect and yields `void`.
 */
export const backfill = <E extends { readonly message?: string }>(
  effect: Effect.Effect<unknown, E, Database>
): Effect.Effect<void, MigrationError, Database> =>
  Effect.mapError(
    Effect.asVoid(effect),
    (cause) => new MigrationError({ message: `backfill failed: ${cause.message ?? String(cause)}`, cause })
  )

/**
 * @param material - Text to hash.
 * @returns Deterministic eight-character FNV-1a hexadecimal hash.
 */
export const hashText = (material: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Current migration checksum prefix and canonical-material version. */
const CHECKSUM_PREFIX = "sha256:v1:"

/** Result of comparing a journal checksum with the current migration definition. */
export type MigrationChecksumStatus = "current" | "legacy" | "mismatch" | "unknown-algorithm"

/**
 * @param fields - Ordered semantic fields to serialize without delimiter ambiguity.
 * @returns Canonical JSON material for the v1 checksum algorithm.
 */
const canonicalMaterial = (fields: ReadonlyArray<readonly [string, string | boolean | null]>): string =>
  JSON.stringify(["thor-migration-checksum", 1, fields])

/**
 * @param material - Canonical checksum material.
 * @returns A versioned SHA-256 digest.
 */
export const checksumText = (material: string): string =>
  `${CHECKSUM_PREFIX}${createHash("sha256").update(material, "utf8").digest("hex")}`

/**
 * Computes the historical eight-character FNV-1a migration checksum. This is
 * retained only to verify existing journal rows; new rows always use SHA-256.
 *
 * @param definition - Migration definition to fingerprint using the legacy algorithm.
 * @returns The legacy unversioned checksum.
 */
export const legacyChecksum = (definition: MigrationDefinition): string =>
  hashText(
    (isSqlStatement(definition.up) ? definition.up.sql : `effect:${definition.revision}:up`) +
      "|" +
      (definition.down && isSqlStatement(definition.down)
        ? definition.down.sql
        : definition.down
          ? `effect:${definition.revision}:down`
          : "none") +
      `|revision:${definition.revision ?? "sql"}`
  )

/**
 * @param definition - Migration definition to fingerprint.
 * @returns Versioned SHA-256 checksum of every execution-relevant field.
 */
export const checksum = (definition: MigrationDefinition): string =>
  checksumText(
    canonicalMaterial([
      ["id", definition.id],
      ["name", definition.name],
      ["up.kind", isSqlStatement(definition.up) ? "sql" : "effect"],
      ["up.value", isSqlStatement(definition.up) ? definition.up.sql : definition.revision],
      ["down.kind", definition.down ? (isSqlStatement(definition.down) ? "sql" : "effect") : "none"],
      [
        "down.value",
        definition.down ? (isSqlStatement(definition.down) ? definition.down.sql : definition.revision) : null
      ],
      ["revision", definition.revision ?? null],
      ["irreversible", definition.irreversible ?? false],
      ["safety", definition.safety ?? null],
      ["phase", definition.phase ?? null]
    ])
  )

/**
 * Compares a stored journal checksum without mutating journal history.
 *
 * @param definition - Current migration definition.
 * @param stored - Checksum read from the journal.
 * @returns Whether the checksum is current, legacy-compatible, mismatched, or uses an unknown algorithm.
 */
export const migrationChecksumStatus = (definition: MigrationDefinition, stored: string): MigrationChecksumStatus => {
  if (stored.startsWith(CHECKSUM_PREFIX)) return stored === checksum(definition) ? "current" : "mismatch"
  if (stored.includes(":")) return "unknown-algorithm"
  return stored === legacyChecksum(definition) ? "legacy" : "mismatch"
}
