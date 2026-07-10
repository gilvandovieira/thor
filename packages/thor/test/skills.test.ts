import { describe, expect, it } from "vitest"
import { SKILLS, skillFiles, skillManifest } from "@gilvandovieira/thor/skills"

const REQUIRED = [
  "thor.schema",
  "thor.query",
  "thor.effect-execution",
  "thor.migrations",
  "thor.capabilities",
  "thor.routines",
  "thor.testing",
  "thor.benchmarks",
  "thor.dialects",
  "thor.debugging",
  "thor.safety"
]

const SECTIONS = [
  "## Goal",
  "## Use When",
  "## Required Checks",
  "## Safe Patterns",
  "## Unsafe Patterns",
  "## Examples",
  "## Verification",
  "## Hard Rule"
]

describe("Epic U2 — the 11 required skills (§21.4)", () => {
  it("authors exactly the required skill set with stable ids and file names", () => {
    expect(SKILLS.map((skill) => skill.id)).toEqual(REQUIRED)
    for (const skill of SKILLS) {
      expect(skill.file).toBe(`${skill.id.replace("thor.", "")}.skill.md`)
      expect(skill.description.length).toBeGreaterThan(0)
    }
  })
})

describe("Epic U1 — skill file shape (§21.3)", () => {
  it("every skill follows the goal/use-when/checks/patterns/examples/verification shape", () => {
    for (const skill of SKILLS) {
      expect(skill.content.startsWith(`# Thor Skill: ${skill.title}`)).toBe(true)
      for (const section of SECTIONS) {
        expect(skill.content, `${skill.id} missing ${section}`).toContain(section)
      }
    }
  })
})

describe("Epic U3 — manifest (§21.5)", () => {
  it("indexes every skill machine-readably", () => {
    const manifest = skillManifest()
    expect(manifest).toMatchObject({ name: "thor", project: "Thor Project", scope: "@gilvandovieira" })
    expect(manifest.skills.map((entry) => entry.id)).toEqual(REQUIRED)
    for (const entry of manifest.skills) {
      expect(entry.file).toMatch(/\.skill\.md$/)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })
})

describe("Epic U4 — exportable file set (§20.5, §21)", () => {
  it("renders markdown files plus README and manifest", () => {
    const files = skillFiles("md")
    const paths = files.map((file) => file.path)
    expect(paths).toContain("thor/README.md")
    expect(paths).toContain("thor/manifest.json")
    for (const skill of SKILLS) expect(paths).toContain(`thor/${skill.file}`)
    // manifest.json is valid JSON indexing the skills.
    const manifest = JSON.parse(files.find((file) => file.path === "thor/manifest.json")!.content)
    expect(manifest.skills).toHaveLength(REQUIRED.length)
  })

  it("renders a single JSON bundle with full contents", () => {
    const files = skillFiles("json")
    expect(files.map((file) => file.path)).toEqual(["thor/skills.json"])
    const bundle = JSON.parse(files[0]!.content)
    expect(bundle.skills).toHaveLength(REQUIRED.length)
    expect(bundle.skills[0].content).toContain("# Thor Skill:")
  })
})

describe("Epic U5 — LLM usage invariant (§21.6)", () => {
  it("encodes the capability-checking and no-raw-interpolation safety rules", () => {
    const all = SKILLS.map((skill) => skill.content).join("\n").toLowerCase()
    // Prefer declared APIs, check capabilities, never interpolate user input.
    expect(all).toContain("check dialect capability")
    expect(all).toContain("never interpolate user input into raw sql")
    expect(all).toContain("unsafesql")
    // Every skill states an explicit hard rule.
    for (const skill of SKILLS) expect(skill.content).toContain("## Hard Rule")
  })
})
