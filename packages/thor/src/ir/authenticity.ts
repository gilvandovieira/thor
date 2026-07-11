/**
 * Same-realm authenticity registries shared by compatible physical Thor copies.
 *
 * @module ir/authenticity
 */

const RegistryKey = Symbol.for("@gilvandovieira/thor/authenticity/v1")

type Registry = Map<string, WeakSet<object>>

/** @returns The process/realm registry for protocol v1. */
const registry = (): Registry => {
  const root = globalThis as typeof globalThis & { [RegistryKey]?: Registry }
  const existing = root[RegistryKey]
  if (existing) return existing
  const created: Registry = new Map()
  Object.defineProperty(root, RegistryKey, { value: created, enumerable: false, writable: false, configurable: false })
  return created
}

/**
 * Returns a shared weak authenticity set for one Thor value family.
 *
 * This protects the data boundary (plain/JSON/proxy lookalikes cannot acquire
 * syntax meaning) and permits two compatible package copies in one JavaScript
 * realm to exchange values. It is not a sandbox against arbitrary same-realm
 * code: such code can already import and invoke Thor's explicit unsafe
 * constructors.
 *
 * @param kind - Versioned value-family name.
 * @returns A realm-shared weak registry.
 * @internal
 */
export const authenticitySet = (kind: string): WeakSet<object> => {
  const sets = registry()
  const existing = sets.get(kind)
  if (existing) return existing
  const created = new WeakSet<object>()
  sets.set(kind, created)
  return created
}
