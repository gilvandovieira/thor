/**
 * Expand/contract migration planning (spec §15.5).
 *
 * A production-safe schema change is split into ordered phases so old and new
 * code can coexist during a rolling deploy:
 *
 * ```txt
 * expand    add the new structure (nullable / non-breaking)
 * backfill  migrate data into it
 * require   tighten constraints once the data is present
 * contract  drop the old structure after nothing depends on it
 * ```
 *
 * {@link planExpandContract} emits those phases as an ordered list of
 * {@link MigrationPlan}s. The **contract** (drop) plan carries a destructive
 * operation, so it stays blocked by {@link guardOperations} unless the run uses a
 * reviewed destructive policy — the drop never slips through with the additive
 * steps.
 *
 * @module migrate/expand-contract
 */
import type { ColumnSpec, MigrationOperation, MigrationPlan } from "./migration-ir.js"

/** A column replacement expressed as an expand/contract change (spec §15.5). */
export interface ExpandContractColumnChange {
  /** Table being altered. */
  readonly table: string
  /** The new column to add. It is always added nullable in the expand phase. */
  readonly add: ColumnSpec
  /** Trusted SQL that copies existing data into the new column (backfill phase). */
  readonly backfillSql: string
  /** Column to `SET NOT NULL` in the require phase (defaults to the added column). */
  readonly requireColumn?: string
  /** Existing column to drop in the contract phase. */
  readonly dropColumn: string
}

/**
 * Plan a column replacement as four ordered migration plans: expand → backfill →
 * require → contract (spec §15.5).
 *
 * @param base - Base identifier; each phase is suffixed (`_1_expand`, …) for a stable, sortable id.
 * @param change - The column change to stage.
 * @returns Four ordered migration plans; the final (drop) plan is destructive.
 */
export const planExpandContract = (
  base: string,
  change: ExpandContractColumnChange
): ReadonlyArray<MigrationPlan> => {
  const requireColumn = change.requireColumn ?? change.add.name

  const expand: MigrationOperation = {
    _tag: "AddColumn",
    table: change.table,
    // Always additive: a nullable column never breaks old inserts.
    column: { ...change.add, nullable: true },
    destructive: false,
    reversible: true,
    capabilities: []
  }
  const backfill: MigrationOperation = {
    _tag: "RawSql",
    sql: change.backfillSql,
    unchecked: true,
    destructive: false,
    reversible: false,
    capabilities: []
  }
  const require: MigrationOperation = {
    _tag: "SetNotNull",
    table: change.table,
    column: requireColumn,
    destructive: false,
    reversible: true,
    capabilities: []
  }
  const contract: MigrationOperation = {
    _tag: "DropColumn",
    table: change.table,
    column: change.dropColumn,
    destructive: true,
    reversible: false,
    capabilities: []
  }

  return [
    { id: `${base}_1_expand`, name: `${base} (expand)`, operations: [expand] },
    { id: `${base}_2_backfill`, name: `${base} (backfill)`, operations: [backfill] },
    { id: `${base}_3_require`, name: `${base} (require)`, operations: [require] },
    { id: `${base}_4_contract`, name: `${base} (contract)`, operations: [contract] }
  ]
}
