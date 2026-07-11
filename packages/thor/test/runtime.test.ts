import { describe, expect, it } from "vitest"
import {
  assertRuntimeCapabilities,
  defineRuntimeCapabilities,
  defineRuntimeRequirements,
  detectRuntimeCapabilities,
  hasRuntimeCapability,
  missingRuntimeCapabilities
} from "@gilvandovieira/thor/capabilities"
import { RuntimeCapabilityError } from "@gilvandovieira/thor"
import {
  BunSQLiteDriverRuntime,
  makeBunSQLiteDriver,
  makeNodeSQLiteDriver,
  makeRuntimeSQLiteDriver,
  makeSQLiteDriver,
  NodeSQLiteDriverRuntime,
  SQLiteDriverRuntime,
  type SQLiteClient
} from "@gilvandovieira/thor/sqlite"

const client: SQLiteClient = {
  prepare: () => ({
    all: () => [],
    run: () => ({ changes: 0 })
  }),
  exec: () => undefined
}

describe("runtime capability detection", () => {
  it("detects Node APIs and built-in SQLite from a modern Node profile", () => {
    const profile = detectRuntimeCapabilities({
      crypto: { subtle: {} },
      process: {
        versions: { node: "26.1.0", napi: "10" },
        env: { VITEST: "true" }
      }
    })

    expect(profile.runtime).toBe("node")
    expect([...profile.capabilities]).toEqual([
      "runtime.node",
      "runtime.nodeCrypto",
      "runtime.fs",
      "runtime.workerThreads",
      "runtime.sqlite.node",
      "runtime.process",
      "runtime.webCrypto",
      "runtime.napi",
      "runtime.testRunner"
    ])
  })

  it("uses Bun's official version signal without misclassifying it as Node", () => {
    const profile = detectRuntimeCapabilities({
      process: {
        versions: { node: "24.3.0", bun: "1.3.0", napi: "9" },
        env: {}
      }
    })

    expect(profile.runtime).toBe("bun")
    expect(hasRuntimeCapability(profile, "runtime.bun")).toBe(true)
    expect(hasRuntimeCapability(profile, "runtime.sqlite.bun")).toBe(true)
    expect(hasRuntimeCapability(profile, "runtime.node")).toBe(false)
    expect(hasRuntimeCapability(profile, "runtime.sqlite.node")).toBe(false)
  })

  it("detects portable Web Crypto without assuming a server runtime", () => {
    const profile = detectRuntimeCapabilities({ crypto: { subtle: {} } })

    expect(profile.runtime).toBe("unknown")
    expect([...profile.capabilities]).toEqual(["runtime.webCrypto"])
  })
})

describe("runtime requirements", () => {
  it("reports every missing capability in declaration order", () => {
    const requirements = defineRuntimeRequirements("example/adapter", ["runtime.bun", "runtime.sqlite.bun"])
    const profile = defineRuntimeCapabilities("node", ["runtime.node"])

    expect(missingRuntimeCapabilities(requirements, profile)).toEqual(["runtime.bun", "runtime.sqlite.bun"])
  })

  it("throws a tagged, actionable error before adapter use", () => {
    const requirements = defineRuntimeRequirements("example/adapter", ["runtime.sqlite.bun"])
    const profile = defineRuntimeCapabilities("node", ["runtime.node"])

    try {
      assertRuntimeCapabilities(requirements, profile)
      expect.unreachable("runtime validation should fail")
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeCapabilityError)
      expect(error).toMatchObject({
        _tag: "RuntimeCapabilityError",
        adapter: "example/adapter",
        runtime: "node",
        missing: ["runtime.sqlite.bun"]
      })
    }
  })
})

describe("SQLite runtime adapters", () => {
  it("keeps the structural adapter runtime-neutral", () => {
    const driver = makeSQLiteDriver(client)

    expect(driver.runtime).toBe(SQLiteDriverRuntime)
    expect(driver.runtime.required).toEqual([])
  })

  it("declares and accepts the Node SQLite runtime contract", () => {
    const profile = defineRuntimeCapabilities("node", ["runtime.node", "runtime.sqlite.node"])
    const driver = makeNodeSQLiteDriver(client, profile)

    expect(driver.runtime).toBe(NodeSQLiteDriverRuntime)
  })

  it("declares the Bun contract and rejects it under Node", () => {
    const profile = defineRuntimeCapabilities("node", ["runtime.node", "runtime.sqlite.node"])

    expect(() => makeBunSQLiteDriver(client, profile)).toThrow(RuntimeCapabilityError)
    expect(BunSQLiteDriverRuntime.required).toEqual(["runtime.bun", "runtime.sqlite.bun"])
  })

  it("accepts Bun SQLite when both host capabilities are present", () => {
    const profile = defineRuntimeCapabilities("bun", ["runtime.bun", "runtime.sqlite.bun"])
    const driver = makeBunSQLiteDriver(client, profile)

    expect(driver.runtime).toBe(BunSQLiteDriverRuntime)
  })

  it("selects the native adapter from the runtime capability matrix", () => {
    const node = defineRuntimeCapabilities("node", ["runtime.node", "runtime.sqlite.node"])
    const bun = defineRuntimeCapabilities("bun", ["runtime.bun", "runtime.sqlite.bun"])

    expect(makeRuntimeSQLiteDriver(client, node).runtime).toBe(NodeSQLiteDriverRuntime)
    expect(makeRuntimeSQLiteDriver(client, bun).runtime).toBe(BunSQLiteDriverRuntime)
  })

  it("rejects runtime selection when native SQLite is unavailable", () => {
    const unknown = defineRuntimeCapabilities("unknown", ["runtime.webCrypto"])
    const bunWithoutSQLite = defineRuntimeCapabilities("bun", ["runtime.bun"])

    expect(() => makeRuntimeSQLiteDriver(client, unknown)).toThrow(RuntimeCapabilityError)
    try {
      makeRuntimeSQLiteDriver(client, bunWithoutSQLite)
      expect.unreachable("Bun without native SQLite should fail")
    } catch (error) {
      expect(error).toMatchObject({ missing: ["runtime.sqlite.bun"] })
    }
  })
})
