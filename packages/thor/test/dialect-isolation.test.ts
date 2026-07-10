import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string): string => readFileSync(resolve("packages/thor/src", path), "utf8")

describe("dialect isolation (v1 spec §11.5)", () => {
  it("keeps adapter imports and dialect identifiers out of shared IR and guards", () => {
    for (const path of ["ir/query-ir.ts", "guards/query-guards.ts"]) {
      const text = source(path)
      expect(text).not.toMatch(/from ["'][^"']*(?:postgres|mysql|sqlite)/)
      expect(text).not.toMatch(/["'](?:postgres|mysql|sqlite)["']/)
    }
  })

  it("delegates backend syntax instead of branching on dialect ids", () => {
    for (const path of ["sql/compiler.ts", "execution/transaction.ts"]) {
      const text = source(path)
      expect(text).not.toMatch(/dialect\.id\s*(?:===|!==)/)
      expect(text).not.toMatch(/switch\s*\(\s*[^)]*dialect\.id/)
    }
  })
})
