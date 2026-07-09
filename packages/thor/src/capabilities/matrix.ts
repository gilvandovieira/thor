/**
 * Capability matrix (spec §9.1–9.2): a per-dialect map from capability to status.
 *
 * @module capabilities/matrix
 */
import type { Capability } from "./capability.js"

/** Stable database dialect identifier used in diagnostics and cache keys. */
export type DialectId = "postgres" | (string & {})

/** Level of support a dialect provides for one capability. */
export type CapabilityStatus = "native" | "emulated" | "unsupported" | "unknown"

/** Immutable capability declaration for a database dialect. */
export interface CapabilityMatrix {
  /** Dialect this matrix describes. */
  readonly dialect: DialectId
  /** Capability-to-support mapping. Omitted runtime keys are treated as `unknown`. */
  readonly capabilities: Readonly<Record<Capability, CapabilityStatus>>
}

/**
 * Build a capability matrix. Capabilities not listed default to `"unknown"`,
 * so a partial declaration is safe: unlisted features are treated as
 * not-yet-verified rather than silently supported.
 *
 * @param dialect - Stable identifier for the database backend.
 * @param capabilities - Partial support declaration; omitted entries become `unknown`.
 * @returns Immutable capability matrix.
 */
export const defineCapabilities = (
  dialect: DialectId,
  capabilities: Partial<Record<Capability, CapabilityStatus>>
): CapabilityMatrix => ({
  dialect,
  capabilities: capabilities as Readonly<Record<Capability, CapabilityStatus>>
})

/**
 * Looks up one capability's support status.
 *
 * @param matrix - Dialect capability matrix.
 * @param cap - Capability to inspect.
 * @returns Declared status, or `unknown` when omitted.
 */
export const statusOf = (matrix: CapabilityMatrix, cap: Capability): CapabilityStatus =>
  matrix.capabilities[cap] ?? "unknown"

/**
 * Whether an operation requiring `cap` may proceed on this dialect.
 * `native` always passes; `emulated` passes only when emulation is allowed;
 * `unsupported`/`unknown` never pass.
 *
 * @param matrix - Dialect capability matrix.
 * @param cap - Required capability.
 * @param allowEmulation - Whether emulated implementations are acceptable.
 * @returns `true` when the requirement may execute.
 */
export const isSatisfied = (
  matrix: CapabilityMatrix,
  cap: Capability,
  allowEmulation = false
): boolean => {
  const status = statusOf(matrix, cap)
  return status === "native" || (status === "emulated" && allowEmulation)
}
