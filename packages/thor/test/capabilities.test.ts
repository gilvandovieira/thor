import { describe, expect, it } from "vitest"
import {
  ALL_CAPABILITIES,
  bitsToCapabilities,
  capabilitiesToBits,
  defineCapabilities,
  hasCapability,
  isSatisfied,
  MySQLCapabilities,
  noCapabilities,
  PostgresCapabilities,
  SQLiteCapabilities,
  statusOf,
  unionBits
} from "@gilvandovieira/thor/capabilities"

describe("capability bitsets (spec §9, §15.11)", () => {
  it("round-trips every declared capability in declaration order", () => {
    const bits = capabilitiesToBits(ALL_CAPABILITIES)

    expect(bitsToCapabilities(bits)).toEqual(ALL_CAPABILITIES)
    for (const capability of ALL_CAPABILITIES) {
      expect(hasCapability(bits, capability)).toBe(true)
    }
  })

  it("represents the empty set", () => {
    expect(capabilitiesToBits([])).toBe(noCapabilities)
    expect(bitsToCapabilities(noCapabilities)).toEqual([])
    expect(hasCapability(noCapabilities, "insert.returning")).toBe(false)
  })

  it("deduplicates entries and unions independent sets", () => {
    const writes = capabilitiesToBits(["insert.returning", "insert.returning", "update.returning"])
    const reads = capabilitiesToBits(["select.cte"])

    expect(bitsToCapabilities(unionBits(writes, reads))).toEqual(["insert.returning", "update.returning", "select.cte"])
  })
})

describe("capability matrices", () => {
  it.each([
    ["insert.returning", "native"],
    ["insert.onDuplicateKey", "unsupported"],
    ["migration.lock.table", "emulated"]
  ] as const)("reports Postgres %s as %s", (capability, status) => {
    expect(statusOf(PostgresCapabilities, capability)).toBe(status)
  })

  it("reports omitted capabilities as unknown", () => {
    const partial = defineCapabilities("partial", { "select.cte": "native" })

    expect(statusOf(partial, "select.cte")).toBe("native")
    expect(statusOf(partial, "select.recursiveCte")).toBe("unknown")
  })

  it("requires built-in matrices to declare every capability explicitly", () => {
    for (const matrix of [PostgresCapabilities, SQLiteCapabilities, MySQLCapabilities]) {
      expect(Object.keys(matrix.capabilities).sort()).toEqual([...ALL_CAPABILITIES].sort())
      expect(ALL_CAPABILITIES.every((capability) => matrix.capabilities[capability] !== undefined)).toBe(true)
    }
  })

  it("captures backend-specific returning and DDL behavior", () => {
    expect(statusOf(SQLiteCapabilities, "insert.returning")).toBe("native")
    expect(statusOf(MySQLCapabilities, "insert.returning")).toBe("unsupported")
    expect(statusOf(MySQLCapabilities, "insert.onDuplicateKey")).toBe("native")
    expect(statusOf(MySQLCapabilities, "migration.transactionalDdl")).toBe("unsupported")
  })

  it("reports streaming as unsupported until a scoped cursor driver contract exists", () => {
    for (const matrix of [PostgresCapabilities, SQLiteCapabilities, MySQLCapabilities]) {
      expect(statusOf(matrix, "query.streaming")).toBe("unsupported")
    }
  })

  it.each([
    ["native", false, true],
    ["native", true, true],
    ["emulated", false, false],
    ["emulated", true, true],
    ["unsupported", true, false],
    ["unknown", true, false]
  ] as const)("treats %s with allowEmulation=%s as satisfied=%s", (status, allowEmulation, expected) => {
    const matrix = defineCapabilities("test", { "insert.returning": status })

    expect(isSatisfied(matrix, "insert.returning", allowEmulation)).toBe(expected)
  })
})
