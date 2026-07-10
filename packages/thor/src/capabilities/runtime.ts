/**
 * JavaScript runtime capability detection and adapter requirements.
 *
 * Runtime capabilities are deliberately separate from database capabilities:
 * a SQLite dialect can be shared by Node and Bun while its client adapter may
 * require `node:sqlite` or `bun:sqlite`. Detection is import-free so this module
 * remains safe to load in either runtime and in browser-oriented tooling.
 *
 * @module capabilities/runtime
 */
import { RuntimeCapabilityError } from "../errors/index.js"

/** Every JavaScript runtime capability understood by Thor. */
export const ALL_RUNTIME_CAPABILITIES = [
  "runtime.node",
  "runtime.bun",
  "runtime.webCrypto",
  "runtime.nodeCrypto",
  "runtime.fs",
  "runtime.process",
  "runtime.workerThreads",
  "runtime.testRunner",
  "runtime.sqlite.node",
  "runtime.sqlite.bun",
  "runtime.napi"
] as const

/** Stable identifier for a JavaScript host runtime. */
export type RuntimeId = "node" | "bun" | "unknown"

/** Union of every runtime capability Thor can validate. */
export type RuntimeCapability = (typeof ALL_RUNTIME_CAPABILITIES)[number]

/** @experimental Advanced runtime capability APIs may grow with runtime lanes. */
export interface RuntimeCapabilityProfile {
  /** Host runtime identity. */
  readonly runtime: RuntimeId
  /** Capabilities available in the host. */
  readonly capabilities: ReadonlySet<RuntimeCapability>
}

/** Runtime contract declared by a driver adapter. */
export interface RuntimeRequirements {
  /** Stable adapter name used in diagnostics. */
  readonly adapter: string
  /** Runtime capabilities that must all be available. */
  readonly required: ReadonlyArray<RuntimeCapability>
}

/** Minimal injectable global surface used by runtime detection. */
export interface RuntimeProbe {
  /** Bun's runtime global, when present. */
  readonly Bun?: unknown
  /** Web Crypto global, when present. */
  readonly crypto?: { readonly subtle?: unknown }
  /** Jest global, when present. */
  readonly jest?: unknown
  /** Vitest global, when present. */
  readonly vi?: unknown
  /** Node-compatible process global, when present. */
  readonly process?: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly versions?: Readonly<Record<string, string | undefined>>
  }
}

/**
 * Creates a runtime profile from known capabilities.
 *
 * @param runtime - Host runtime identity.
 * @param capabilities - Available runtime capabilities.
 * @returns An immutable-by-contract runtime profile.
 */
export const defineRuntimeCapabilities = (
  runtime: RuntimeId,
  capabilities: Iterable<RuntimeCapability>
): RuntimeCapabilityProfile => ({ runtime, capabilities: new Set(capabilities) })

/**
 * Declares the runtime contract for a driver adapter.
 *
 * @param adapter - Stable adapter name used in failures and diagnostics.
 * @param required - Capabilities required before the adapter can be used.
 * @returns A deduplicated runtime requirement declaration.
 */
export const defineRuntimeRequirements = (
  adapter: string,
  required: Iterable<RuntimeCapability>
): RuntimeRequirements => ({ adapter, required: [...new Set(required)] })

/**
 * Detects capabilities without importing runtime-specific modules.
 *
 * Bun is identified through `process.versions.bun` or its global. Node's SQLite
 * module is considered available from Node 22.5, where `node:sqlite` shipped.
 * The injectable probe keeps detection deterministic in unit tests and hosts.
 *
 * @experimental Advanced runtime capability APIs may grow with runtime lanes.
 * @param probe - Global-like object to inspect; defaults to `globalThis`.
 * @returns The detected runtime identity and capability set.
 */
export const detectRuntimeCapabilities = (
  probe: RuntimeProbe = globalThis as RuntimeProbe
): RuntimeCapabilityProfile => {
  const versions = probe.process?.versions
  const isBun = typeof versions?.bun === "string" || probe.Bun !== undefined
  const isNode = !isBun && typeof versions?.node === "string"
  const runtime: RuntimeId = isBun ? "bun" : isNode ? "node" : "unknown"
  const capabilities = new Set<RuntimeCapability>()

  if (isNode) {
    capabilities.add("runtime.node")
    capabilities.add("runtime.nodeCrypto")
    capabilities.add("runtime.fs")
    capabilities.add("runtime.workerThreads")

    const [major = 0, minor = 0] = versions?.node?.split(".").map(Number) ?? []
    if (major > 22 || (major === 22 && minor >= 5)) capabilities.add("runtime.sqlite.node")
  }

  if (isBun) {
    capabilities.add("runtime.bun")
    capabilities.add("runtime.fs")
    capabilities.add("runtime.sqlite.bun")
  }

  if (probe.process !== undefined) capabilities.add("runtime.process")
  if (probe.crypto?.subtle !== undefined) capabilities.add("runtime.webCrypto")
  if (typeof versions?.napi === "string") capabilities.add("runtime.napi")

  const env = probe.process?.env
  if (
    probe.vi !== undefined ||
    probe.jest !== undefined ||
    env?.VITEST === "true" ||
    env?.JEST_WORKER_ID !== undefined
  ) {
    capabilities.add("runtime.testRunner")
  }

  return defineRuntimeCapabilities(runtime, capabilities)
}

/**
 * Checks whether a runtime profile includes a capability.
 *
 * @param profile - Runtime profile to inspect.
 * @param capability - Required capability.
 * @returns `true` when the capability is available.
 */
export const hasRuntimeCapability = (
  profile: RuntimeCapabilityProfile,
  capability: RuntimeCapability
): boolean => profile.capabilities.has(capability)

/**
 * Finds every adapter requirement absent from a runtime profile.
 *
 * @param requirements - Adapter runtime contract.
 * @param profile - Available runtime capabilities.
 * @returns Missing capabilities in declaration order.
 */
export const missingRuntimeCapabilities = (
  requirements: RuntimeRequirements,
  profile: RuntimeCapabilityProfile
): ReadonlyArray<RuntimeCapability> =>
  requirements.required.filter((capability) => !hasRuntimeCapability(profile, capability))

/**
 * Validates an adapter against the current or supplied runtime profile.
 *
 * @param requirements - Adapter runtime contract.
 * @param profile - Available runtime profile; defaults to auto-detection.
 * @returns Nothing when every requirement is satisfied.
 * @throws {RuntimeCapabilityError} When one or more capabilities are missing.
 */
export const assertRuntimeCapabilities = (
  requirements: RuntimeRequirements,
  profile: RuntimeCapabilityProfile = detectRuntimeCapabilities()
): void => {
  const missing = missingRuntimeCapabilities(requirements, profile)
  if (missing.length === 0) return

  throw new RuntimeCapabilityError({
    adapter: requirements.adapter,
    runtime: profile.runtime,
    required: requirements.required,
    missing,
    message: `Adapter "${requirements.adapter}" requires ${missing.join(", ")} under runtime "${profile.runtime}"`
  })
}
