/**
 * Capability identifiers and their compact bitset encoding (spec §9, §15.11).
 *
 * Public APIs speak readable capability names; internals accumulate them into a
 * `bigint` bitset (`CapabilityBits`) so guard/capability checks on the hot path
 * are cheap bitwise ops rather than array/set scans.
 *
 * @module capabilities/capability
 */

/** Every capability Thor can reason about. Add new capabilities here only. */
export const ALL_CAPABILITIES = [
  "insert.returning",
  "update.returning",
  "delete.returning",
  "insert.onConflict",
  "insert.onDuplicateKey",

  "select.cte",
  "select.recursiveCte",
  "select.windowFunctions",
  "select.lateralJoin",
  "select.rightJoin",
  "select.fullJoin",
  "select.setOperations",
  "select.forUpdate",

  "transaction.savepoints",
  "transaction.isolationLevel",

  "schema.json",
  "schema.array",
  "schema.enum",
  "schema.generatedColumns",
  "schema.identityColumns",

  "query.streaming",
  "query.preparedStatements",

  "routine.functionCall",
  "routine.procedureCall",
  "routine.tableValuedFunction",
  "routine.namedArguments",
  "routine.outParameters",
  "routine.overloading",
  "routine.variadicArguments",
  "routine.defaultArguments",
  "routine.schemaQualifiedName",
  "routine.extensionRequired",

  "migration.lock.advisory",
  "migration.lock.table",
  "migration.transactionalDdl",
  "migration.rollbackDdl"
] as const

/** Union of every capability identifier understood by Thor. */
export type Capability = (typeof ALL_CAPABILITIES)[number]

/** Compact bitset of capabilities. One `bigint` bit per capability index. */
export type CapabilityBits = bigint

/** Stable capability -> bit-index map, derived once from `ALL_CAPABILITIES`. */
const BIT_INDEX: ReadonlyMap<Capability, number> = new Map(
  ALL_CAPABILITIES.map((cap, i) => [cap, i] as const)
)

const readableCapabilitiesCache = new Map<CapabilityBits, ReadonlyArray<Capability>>()

/** The empty capability set. */
export const noCapabilities: CapabilityBits = 0n

/**
 * Returns the single bit assigned to a capability.
 *
 * @param cap - Capability to encode.
 * @returns A bitset containing only `cap`.
 * @throws {Error} If a value outside `ALL_CAPABILITIES` reaches runtime.
 */
export const capabilityBit = (cap: Capability): CapabilityBits => {
  const index = BIT_INDEX.get(cap)
  if (index === undefined) {
    throw new Error(`Unknown capability: ${cap}`)
  }
  return 1n << BigInt(index)
}

/**
 * Encodes capabilities into a compact bitset.
 *
 * @param caps - Capability values to encode; duplicates are ignored naturally.
 * @returns Bitwise union of all requested capabilities.
 */
export const capabilitiesToBits = (caps: Iterable<Capability>): CapabilityBits => {
  let bits = noCapabilities
  for (const cap of caps) bits |= capabilityBit(cap)
  return bits
}

/**
 * Unions two encoded capability sets.
 *
 * @param a - First bitset.
 * @param b - Second bitset.
 * @returns A bitset containing capabilities from both inputs.
 */
export const unionBits = (a: CapabilityBits, b: CapabilityBits): CapabilityBits => a | b

/**
 * Tests whether a bitset includes a capability.
 *
 * @param bits - Encoded capability set.
 * @param cap - Capability to look up.
 * @returns `true` when `cap` is present.
 */
export const hasCapability = (bits: CapabilityBits, cap: Capability): boolean =>
  (bits & capabilityBit(cap)) !== 0n

/**
 * Expands a bitset into readable capability names.
 *
 * @param bits - Encoded capability set.
 * @returns Capabilities in stable `ALL_CAPABILITIES` declaration order.
 */
export const bitsToCapabilities = (bits: CapabilityBits): ReadonlyArray<Capability> => {
  const cached = readableCapabilitiesCache.get(bits)
  if (cached !== undefined) return cached

  const out: Capability[] = []
  for (const cap of ALL_CAPABILITIES) {
    if (hasCapability(bits, cap)) out.push(cap)
  }
  const capabilities = Object.freeze(out)
  readableCapabilitiesCache.set(bits, capabilities)
  return capabilities
}
