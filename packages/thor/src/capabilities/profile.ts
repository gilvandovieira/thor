/**
 * Capability-profile hashing (spec §15.14).
 *
 * A dialect's compiled cache key must be scoped by its capability profile, not
 * just its id — two dialects (or two versions of one) with the same id but
 * different capability support must not collide in the compiled-SQL cache. The
 * profile hash is a stable 8-char hex digest of the dialect id plus every
 * capability's status in declaration order. It is memoized per matrix instance,
 * so the per-compile cost is a single map lookup.
 *
 * @module capabilities/profile
 */
import { ALL_CAPABILITIES } from "./capability.js"
import { type CapabilityMatrix, type DialectId, statusOf } from "./matrix.js"
import { hashString } from "../internal/hash.js"

const profileCache = new WeakMap<CapabilityMatrix, string>()

/** Single-status codes keep the hashed material compact and order-stable. */
const STATUS_CODE = { native: "n", emulated: "e", unsupported: "x", unknown: "u" } as const

/**
 * Returns a stable hash of a dialect's capability profile.
 *
 * @param matrix - Dialect capability matrix.
 * @returns Eight-character hexadecimal profile hash (memoized per matrix).
 */
export const capabilityProfileHash = (matrix: CapabilityMatrix): string => {
  const cached = profileCache.get(matrix)
  if (cached !== undefined) return cached

  let material = matrix.dialect
  for (const capability of ALL_CAPABILITIES) material += STATUS_CODE[statusOf(matrix, capability)]

  const hash = hashString(material)
  profileCache.set(matrix, hash)
  return hash
}

/**
 * Combines dialect syntax version and capability support into one profile id.
 *
 * @param dialect - Stable database dialect identifier.
 * @param version - Dialect/compiler syntax version.
 * @param matrix - Capability support declaration.
 * @returns Eight-character versioned dialect-profile hash.
 */
export const dialectProfileHash = (
  dialect: DialectId,
  version: string,
  matrix: CapabilityMatrix
): string => hashString(`${dialect}:${version}:${capabilityProfileHash(matrix)}`)
