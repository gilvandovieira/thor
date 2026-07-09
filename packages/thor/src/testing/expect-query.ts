/**
 * Query/guard/capability assertion helpers (spec §14.6, §14.7).
 *
 * @module testing/expect-query
 */
import type { Capability } from "../capabilities/capability.js"
import type { CapabilityMatrix } from "../capabilities/matrix.js"
import { collectViolations } from "../guards/query-guards.js"
import type { QueryIR } from "../ir/query-ir.js"

/** Anything exposing its required capabilities (query builder result types). */
export interface Capable {
  /** @returns Capabilities required by the query shape. */
  readonly requiredCapabilities: () => ReadonlyArray<Capability>
}

/**
 * Assert a query requires exactly the given capabilities (order-independent).
 * Returns `{ ok, expected, actual }` for use with your test runner.
 *
 * @param query - Query exposing required capabilities.
 * @param expected - Exact expected capability set.
 * @returns A runner-agnostic comparison result with sorted values.
 */
export const expectCapabilities = (query: Capable, expected: ReadonlyArray<Capability>) => {
  const actual = [...query.requiredCapabilities()].sort()
  const want = [...expected].sort()
  return {
    ok: actual.length === want.length && actual.every((c, i) => c === want[i]),
    expected: want,
    actual
  }
}

/**
 * @param ir - Query IR to validate.
 * @param matrix - Dialect capability matrix.
 * @param allowEmulation - Whether emulated capabilities are accepted.
 * @returns Tagged guard and capability violations.
 */
export const expectGuardViolations = (ir: QueryIR, matrix: CapabilityMatrix, allowEmulation = false) =>
  collectViolations(ir, matrix, allowEmulation)
