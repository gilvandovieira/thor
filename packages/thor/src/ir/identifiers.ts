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
 * Enforces Thor's backend-neutral identifier floor.
 *
 * Delimiters, whitespace, Unicode, reserved words, and dots remain opaque
 * identifier content and are quoted by the active dialect. Backend-specific
 * byte limits are deliberately left to the backend because they differ by
 * server, encoding, and object kind. Empty strings and NUL cannot denote a
 * portable catalog identifier and are rejected before compilation.
 *
 * @param value - Candidate schema identifier or query alias.
 * @returns The validated identifier unchanged.
 * @throws {TypeError} When the value is not a string, is empty, or contains NUL.
 * @internal
 */
export const validateIdentifier = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("SQL identifiers must be strings")
  if (value.length === 0) throw new TypeError("SQL identifiers cannot be empty")
  if (value.includes("\0")) throw new TypeError("SQL identifiers cannot contain NUL")
  return value
}

/**
 * Returns the canonical value for a stable identifier or alias.
 *
 * @param value - Schema identifier or result alias.
 * @returns Previously interned value, or `value` when new or beyond the pool bound.
 */
export const internIdentifier = (value: string): string => {
  validateIdentifier(value)
  const existing = identifiers.get(value)
  if (existing !== undefined) return existing
  if (identifiers.size >= MAX_INTERNED_IDENTIFIERS) return value
  identifiers.set(value, value)
  return value
}
