/**
 * Bounded interning for stable schema identifiers and selection aliases.
 *
 * JavaScript engines already optimize strings aggressively, but retaining one
 * canonical primitive for repeated schema names avoids rebuilding equivalent
 * identifier values throughout table and query metadata. The bound prevents
 * dynamic-schema workloads from turning the pool into an unbounded cache.
 *
 * @module ir/identifiers
 */

const MAX_INTERNED_IDENTIFIERS = 4096
const identifiers = new Map<string, string>()

/**
 * Returns the canonical value for a stable identifier or alias.
 *
 * @param value - Schema identifier or result alias.
 * @returns Previously interned value, or `value` when new or beyond the pool bound.
 */
export const internIdentifier = (value: string): string => {
  const existing = identifiers.get(value)
  if (existing !== undefined) return existing
  if (identifiers.size >= MAX_INTERNED_IDENTIFIERS) return value
  identifiers.set(value, value)
  return value
}
