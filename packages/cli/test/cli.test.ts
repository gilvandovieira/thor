import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ALL_CAPABILITIES,
  ALL_RUNTIME_CAPABILITIES,
  MySQLCapabilities,
  PostgresCapabilities,
  SQLiteCapabilities,
  statusOf
} from "@gilvandovieira/thor/capabilities"
import { SKILLS } from "@gilvandovieira/thor/skills"

const cli = resolve("packages/cli/dist/index.js")
const directories: string[] = []
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "thor-cli-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("published CLI surface", () => {
  it("advertises and executes the shipped commands", () => {
    const cwd = project()
    const help = execFileSync(process.execPath, [cli, "--help"], { cwd, encoding: "utf8" })
    expect(help).toContain("init")
    expect(help).toContain("create <name>")
    expect(help).toContain("capabilities <dialect|runtime>")
    expect(help).not.toContain("up                Apply")

    execFileSync(process.execPath, [cli, "init"], { cwd })
    execFileSync(process.execPath, [cli, "create", "add_users"], { cwd })
    const migration = readdirSync(join(cwd, "migrations")).find((file) => file.endsWith("_add_users.ts"))
    expect(migration).toBeDefined()
    expect(readFileSync(join(cwd, "migrations", migration!), "utf8")).toContain('name: "add_users"')
  })

  it("prints every capability from the authoritative matrix", () => {
    const cwd = project()
    const matrices = {
      postgres: PostgresCapabilities,
      sqlite: SQLiteCapabilities,
      mysql: MySQLCapabilities
    } as const

    for (const [dialect, matrix] of Object.entries(matrices)) {
      const output = execFileSync(process.execPath, [cli, "capabilities", dialect], { cwd, encoding: "utf8" })
      const expected = [
        `Dialect: ${dialect}`,
        "Capability\tStatus",
        ...ALL_CAPABILITIES.map((capability) => `${capability}\t${statusOf(matrix, capability)}`),
        ""
      ].join("\n")
      expect(output).toBe(expected)
      expect(new Set(output.trim().split("\n").slice(2).map((row) => row.split("\t")[0])).size).toBe(ALL_CAPABILITIES.length)
    }
  })

  it("prints the detected runtime's capabilities", () => {
    const cwd = project()
    const output = execFileSync(process.execPath, [cli, "capabilities", "runtime"], { cwd, encoding: "utf8" })
    const lines = output.trim().split("\n")
    expect(lines[0]).toBe("Runtime: node")
    expect(lines[1]).toBe("Capability\tStatus")
    const reported = new Set(lines.slice(2).map((row) => row.split("\t")[0]))
    expect(reported.size).toBe(ALL_RUNTIME_CAPABILITIES.length)
    // Node is detected as native; Bun is unsupported on this host.
    expect(output).toContain("runtime.node\tnative")
    expect(output).toContain("runtime.bun\tunsupported")
  })

  it("rejects missing, extra, and unknown capability targets", () => {
    const cwd = project()
    for (const [args, message] of [
      [["capabilities"], "Usage: thor capabilities"],
      [["capabilities", "sqlite", "extra"], "Usage: thor capabilities"],
      [["capabilities", "oracle"], "Unknown target: oracle"]
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(message)
    }
  })

  it("lists the LLM skills", () => {
    const cwd = project()
    const output = execFileSync(process.execPath, [cli, "skills", "list"], { cwd, encoding: "utf8" })
    expect(output.split("\n")[0]).toBe("Skill\tDescription")
    expect(output).toContain("thor.query\t")
    expect(output).toContain("thor.safety\t")
    expect(output.trim().split("\n").length).toBe(SKILLS.length + 1) // header + one per skill
  })

  it("exports skills as markdown files plus README and manifest", () => {
    const cwd = project()
    execFileSync(process.execPath, [cli, "skills", "export", "--to", ".agents/skills"], { cwd })
    const dir = join(cwd, ".agents", "skills", "thor")
    const files = readdirSync(dir)
    expect(files).toContain("README.md")
    expect(files).toContain("manifest.json")
    for (const skill of SKILLS) expect(files).toContain(skill.file)
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
    expect(manifest.skills).toHaveLength(SKILLS.length)
  })

  it("exports skills as a single JSON bundle", () => {
    const cwd = project()
    execFileSync(process.execPath, [cli, "skills", "export", "--format", "json"], { cwd })
    const bundle = JSON.parse(readFileSync(join(cwd, ".agents", "skills", "thor", "skills.json"), "utf8"))
    expect(bundle.skills).toHaveLength(SKILLS.length)
    expect(bundle.skills[0].content).toContain("# Thor Skill:")
  })

  it("fails placeholder commands, unsafe names, and bad skills usage with a non-zero exit", () => {
    const cwd = project()
    const unsupported = spawnSync(process.execPath, [cli, "up"], { cwd, encoding: "utf8" })
    expect(unsupported.status).toBe(1)
    expect(unsupported.stderr).toContain("Unsupported command: up")

    const unsafe = spawnSync(process.execPath, [cli, "create", "../escape"], { cwd, encoding: "utf8" })
    expect(unsafe.status).toBe(1)
    expect(unsafe.stderr).toContain("Migration name must")

    const badFormat = spawnSync(process.execPath, [cli, "skills", "export", "--format", "yaml"], { cwd, encoding: "utf8" })
    expect(badFormat.status).toBe(1)
    expect(badFormat.stderr).toContain("Usage: thor skills export")

    const badSub = spawnSync(process.execPath, [cli, "skills", "wat"], { cwd, encoding: "utf8" })
    expect(badSub.status).toBe(1)
    expect(badSub.stderr).toContain("Usage: thor skills")
  })
})
