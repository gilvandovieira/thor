import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { sql } from "@gilvandovieira/thor"

describe("property: untrusted values cannot acquire SQL syntax meaning", () => {
  it("rejects JSON-reachable UnsafeSql lookalikes", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        const forged = JSON.parse(JSON.stringify({ _tag: "UnsafeSql", sql: JSON.stringify(payload) ?? "null" }))
        expect(() => sql`${forged as never}`).toThrow(TypeError)
      }),
      { seed: 0x54484f52, numRuns: 500 }
    )
  })
})
