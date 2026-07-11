import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("migration safety documentation contract", () => {
  it("does not present omitted safety as runnable under the default policy", () => {
    const readme = readFileSync("README.md", "utf8")
    const example = readme.slice(readme.indexOf("const migrations = ["), readme.indexOf("Use `Introspector.drift()`"))

    expect(example).toContain('safety: "additive"')
    expect(example).toContain('phase: "expand"')
  })

  it("states that omitted safety is unchecked and reviewed-only", () => {
    for (const file of ["docs/migrations.md", "docs/limitations.md", "packages/thor/src/migrate/define-migration.ts"]) {
      const text = readFileSync(file, "utf8")
      expect(text.toLowerCase(), file).toContain("unchecked")
      expect(text.toLowerCase(), file).not.toMatch(/omitted[^.]{0,100}(implicitly|trusted|additive)/)
    }
  })
})
