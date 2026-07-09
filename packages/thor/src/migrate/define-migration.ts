/**
 * Migration authoring (spec §13.3–13.4). A migration's `up`/`down` may be a raw
 * SQL statement (`sql`) or an `Effect` for data backfills (`rawSql`, or any
 * `Effect<void, MigrationError, Database>`).
 *
 * @module migrate/define-migration
 */
import { Effect } from "effect"
import { MigrationError } from "../errors/index.js"
import { Database } from "../execution/database.js"

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

/** User-authored, ordered migration definition. */
export interface MigrationDefinition {
  /** Stable, sortable migration identifier. */
  readonly id: string
  /** Human-readable migration name. */
  readonly name: string
  /** Forward migration step. */
  readonly up: MigrationStep
  /** Omit or mark irreversible to signal `down` is unavailable. */
  readonly down?: MigrationStep
  /** Explicitly marks the migration as impossible to roll back. */
  readonly irreversible?: boolean
}

/**
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
 * @param values - Values converted directly to text without parameter binding.
 * @returns A trimmed tagged SQL statement.
 * @remarks Only interpolate trusted values; migration templates are not parameterized.
 */
export const sql = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): SqlStatement => {
  let out = ""
  strings.forEach((chunk, i) => {
    out += chunk
    if (i < values.length) out += String(values[i])
  })
  return { _tag: "SqlStatement", sql: out.trim() }
}

/**
 * Effect migration step that runs a raw SQL statement inside the migration
 * transaction (spec §13.4). Values are inlined as text — migrations take no
 * bound params.
 *
 * @param strings - Static template chunks.
 * @param values - Values converted directly to text without parameter binding.
 * @returns An Effect executing the script through the active `Database` driver.
 */
export const rawSql = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): Effect.Effect<void, MigrationError, Database> => {
  let text = ""
  strings.forEach((chunk, i) => {
    text += chunk
    if (i < values.length) text += String(values[i])
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

/**
 * @param definition - Migration definition to fingerprint.
 * @returns Stable checksum of both directions.

 */
export const checksum = (definition: MigrationDefinition): string =>
  hashText(
    (isSqlStatement(definition.up) ? definition.up.sql : `effect:${definition.id}:up`) +
      "|" +
      (definition.down && isSqlStatement(definition.down) ? definition.down.sql : `effect:${definition.id}:down`)
  )
