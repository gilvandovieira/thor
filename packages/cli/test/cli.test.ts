import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

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
  it("advertises and executes only init/create", () => {
    const cwd = project()
    const help = execFileSync(process.execPath, [cli, "--help"], { cwd, encoding: "utf8" })
    expect(help).toContain("init")
    expect(help).toContain("create <name>")
    expect(help).not.toContain("up                Apply")

    execFileSync(process.execPath, [cli, "init"], { cwd })
    execFileSync(process.execPath, [cli, "create", "add_users"], { cwd })
    const migration = readdirSync(join(cwd, "migrations")).find((file) => file.endsWith("_add_users.ts"))
    expect(migration).toBeDefined()
    expect(readFileSync(join(cwd, "migrations", migration!), "utf8")).toContain('name: "add_users"')
  })

  it("fails placeholder commands and unsafe migration names with a non-zero exit", () => {
    const cwd = project()
    const unsupported = spawnSync(process.execPath, [cli, "up"], { cwd, encoding: "utf8" })
    expect(unsupported.status).toBe(1)
    expect(unsupported.stderr).toContain("only ships \"init\" and \"create\"")

    const unsafe = spawnSync(process.execPath, [cli, "create", "../escape"], { cwd, encoding: "utf8" })
    expect(unsafe.status).toBe(1)
    expect(unsafe.stderr).toContain("Migration name must")
  })
})
