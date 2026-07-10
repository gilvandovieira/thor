import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ALL_CAPABILITIES,
  MySQLCapabilities,
  PostgresCapabilities,
  SQLiteCapabilities,
  statusOf
} from "@gilvandovieira/thor/capabilities"

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
    expect(help).toContain("capabilities <dialect>")
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

  it("rejects missing, extra, and unknown capability targets", () => {
    const cwd = project()
    for (const [args, message] of [
      [["capabilities"], "Usage: thor capabilities"],
      [["capabilities", "sqlite", "extra"], "Usage: thor capabilities"],
      [["capabilities", "oracle"], "Unknown dialect: oracle"]
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(message)
    }
  })

  it("fails placeholder commands and unsafe migration names with a non-zero exit", () => {
    const cwd = project()
    const unsupported = spawnSync(process.execPath, [cli, "up"], { cwd, encoding: "utf8" })
    expect(unsupported.status).toBe(1)
    expect(unsupported.stderr).toContain("Unsupported command: up")

    const unsafe = spawnSync(process.execPath, [cli, "create", "../escape"], { cwd, encoding: "utf8" })
    expect(unsafe.status).toBe(1)
    expect(unsafe.stderr).toContain("Migration name must")
  })
})
