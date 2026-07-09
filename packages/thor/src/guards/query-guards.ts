/**
 * Query construction & capability guards (spec §8.1).
 *
 * Guards are pure: `collectViolations` returns the tagged errors it finds so
 * they are trivially unit-testable (spec §14.6). `guardQuery` is the Effect
 * wrapper that fails with the first violation before compilation/execution.
 *
 * @module guards/query-guards
 */
import { Effect } from "effect"
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import { bitsToCapabilities } from "../capabilities/capability.js"
import { isSatisfied } from "../capabilities/matrix.js"
import type { ColumnRefNode, ExprNode, QueryIR, SelectionField } from "../ir/query-ir.js"
import { CapabilityError, GuardError } from "../errors/index.js"

/** Structural or capability failure discovered before execution. */
export type Violation = GuardError | CapabilityError

/**
 * Recursively collects column references from an expression tree.
 *
 * @param node - Expression to traverse.
 * @param out - Mutable accumulator used during recursion.
 * @returns The populated accumulator.
 */
const columnRefsIn = (node: ExprNode | undefined, out: ColumnRefNode[] = []): ColumnRefNode[] => {
  if (!node) return out
  switch (node._tag) {
    case "ColumnRef":
      out.push(node)
      break
    case "Comparison":
      columnRefsIn(node.left, out)
      columnRefsIn(node.right, out)
      break
    case "InList":
      columnRefsIn(node.expr, out)
      for (const v of node.values) columnRefsIn(v, out)
      break
    case "Logical":
      for (const o of node.operands) columnRefsIn(o, out)
      break
    case "Not":
    case "IsNull":
      columnRefsIn(node.expr, out)
      break
    default:
      break
  }
  return out
}

/**
 * @param fields - Optional selected fields.
 * @returns Every column referenced by their expressions.
 */
const refsInSelection = (fields: ReadonlyArray<SelectionField> | undefined): ColumnRefNode[] =>
  (fields ?? []).flatMap((f) => columnRefsIn(f.expr))

/**
 * Enforces the table-scope guard from spec §8.1.
 *
 * @param scope - Table names visible to the query.
 * @param refs - Column references to validate.
 * @param out - Mutable violation accumulator.
 * @returns Nothing; violations are appended to `out`.
 */
const checkScope = (scope: ReadonlySet<string>, refs: ReadonlyArray<ColumnRefNode>, out: Violation[]): void => {
  for (const ref of refs) {
    if (ref.table && !scope.has(ref.table)) {
      out.push(
        new GuardError({
          guard: "table-scope",
          message: `Column "${ref.table}"."${ref.column}" is not in query scope {${[...scope].join(", ")}}`
        })
      )
    }
  }
}

/**
 * Runs guards that depend only on the immutable query shape.
 *
 * @param ir - Query representation to validate.
 * @returns Structural violations, or an empty array when the shape is valid.
 */
export const collectStructuralViolations = (ir: QueryIR): ReadonlyArray<GuardError> => {
  const out: GuardError[] = []
  switch (ir._tag) {
    case "Select": {
      const scope = new Set([ir.from.name])
      checkScope(scope, [...refsInSelection(ir.selection), ...columnRefsIn(ir.where)], out)
      break
    }
    case "Insert": {
      if (ir.columns.length === 0) {
        out.push(new GuardError({ guard: "insert-shape", message: "Insert has no columns" }))
      }
      for (const [i, row] of ir.rows.entries()) {
        if (row.length !== ir.columns.length) {
          out.push(
            new GuardError({
              guard: "insert-shape",
              message: `Insert row ${i} has ${row.length} values but ${ir.columns.length} columns`
            })
          )
        }
      }
      checkScope(new Set([ir.into.name]), refsInSelection(ir.returning), out)
      break
    }
    case "Update": {
      if (ir.set.length === 0) {
        out.push(new GuardError({ guard: "update-shape", message: "Update has an empty SET clause" }))
      }
      const scope = new Set([ir.table.name])
      checkScope(scope, [...columnRefsIn(ir.where), ...refsInSelection(ir.returning)], out)
      break
    }
    case "Delete": {
      const scope = new Set([ir.from.name])
      checkScope(scope, [...columnRefsIn(ir.where), ...refsInSelection(ir.returning)], out)
      break
    }
  }
  return out
}

/**
 * Runs guards whose result depends on a dialect capability profile.
 *
 * @param ir - Query representation to validate.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns Capability violations, or an empty array when every requirement is satisfied.
 */
export const collectCapabilityViolations = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation = false
): ReadonlyArray<CapabilityError> => {
  const out: CapabilityError[] = []
  for (const capability of bitsToCapabilities(ir.capabilities)) {
    if (!isSatisfied(matrix, capability, allowEmulation)) {
      out.push(
      new CapabilityError({
          capability,
        dialect: matrix.dialect,
          message: `Capability "${capability}" is not available on dialect "${matrix.dialect}"`
      })
    )
    }
  }
  return out
}

/**
 * Runs every structural and capability guard against query IR.
 *
 * @param ir - Query representation to validate.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns Every discovered violation, or an empty array when valid.
 */
export const collectViolations = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation = false
): ReadonlyArray<Violation> => [
  ...collectCapabilityViolations(ir, matrix, allowEmulation),
  ...collectStructuralViolations(ir)
]

/**
 * Converts pure guard results into an Effect failure channel.
 *
 * @param ir - Query representation to validate.
 * @param matrix - Active dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities satisfy requirements.
 * @returns `Effect.void` when valid, otherwise an Effect failing with the first violation.
 */
export const guardQuery = (
  ir: QueryIR,
  matrix: CapabilityMatrix,
  allowEmulation = false
): Effect.Effect<void, Violation> => {
  const violations = collectViolations(ir, matrix, allowEmulation)
  return violations.length > 0 ? Effect.fail(violations[0]!) : Effect.void
}
