/**
 * Dialect-aware parameter budgets for relation query batching.
 *
 * @module relations/parameter-budget
 */
import type { DialectId } from "../capabilities/matrix.js"

/** Conservative ceiling retained for relation predicates and expression depth. */
export const RELATION_PARAMETER_CEILING = 800

const nativeParameterLimits: Readonly<Record<string, number>> = {
  postgres: 65_535,
  sqlite: 32_766,
  mysql: 65_535
}

/**
 * Returns the values available to one relation predicate after parameters
 * already owned by the surrounding query are reserved. The conservative
 * relation ceiling also avoids oversized MySQL packets and deep SQLite
 * expression trees even where the wire protocol permits more placeholders.
 *
 * @param dialect - Active built-in SQL dialect.
 * @param existingParameters - Parameters already consumed by the query shape.
 * @returns A non-negative count of parameters available to relation keys.
 * @internal
 */
export const relationParameterBudget = (dialect: DialectId, existingParameters = 0): number => {
  if (!Number.isSafeInteger(existingParameters) || existingParameters < 0) {
    throw new TypeError("Existing parameter count must be a non-negative safe integer")
  }
  const nativeLimit = nativeParameterLimits[dialect] ?? RELATION_PARAMETER_CEILING
  return Math.max(0, Math.min(RELATION_PARAMETER_CEILING, nativeLimit) - existingParameters)
}
