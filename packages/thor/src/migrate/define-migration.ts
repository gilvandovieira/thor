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

interface MigrationDefinitionBase {
  /** Stable, sortable migration identifier. */
  readonly id: string
  /** Human-readable migration name. */
  readonly name: string
  /** Explicitly marks the migration as impossible to roll back. */
  readonly irreversible?: boolean
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
  Effect.mapError(Effect.asVoid(effect), (cause) =>
    new MigrationError({ message: `backfill failed: ${cause.message ?? String(cause)}`, cause }))

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
    (isSqlStatement(definition.up) ? definition.up.sql : `effect:${definition.revision}:up`) +
      "|" +
      (definition.down && isSqlStatement(definition.down)
        ? definition.down.sql
        : definition.down ? `effect:${definition.revision}:down` : "none") +
      `|revision:${definition.revision ?? "sql"}`
  )
