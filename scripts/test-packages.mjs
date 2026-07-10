/** Packs both public packages and verifies them from a clean consumer project. */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "thor-pack-"))
const artifacts = join(temporary, "artifacts")
const consumer = join(temporary, "consumer")

const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim()

const pack = (directory) => {
  const output = run("pnpm", ["--dir", directory, "pack", "--pack-destination", artifacts])
  const path = output.split("\n").at(-1)
  if (!path) throw new Error(`pnpm pack returned no artifact for ${directory}`)
  return resolve(directory, path)
}

const assertTarball = (tarball) => {
  const entries = run("tar", ["-tzf", tarball]).split("\n")
  for (const required of ["package/package.json", "package/README.md", "package/LICENSE"]) {
    if (!entries.includes(required)) throw new Error(`${tarball} is missing ${required}`)
  }
  const unintended = entries.find(
    (entry) => entry.includes("/src/") || entry.includes("/test/") || entry.endsWith(".tsbuildinfo")
  )
  if (unintended) throw new Error(`${tarball} contains unintended file ${unintended}`)
  for (const stale of ["package/dist/execution/index.js", "package/dist/guards/index.js"]) {
    if (entries.includes(stale)) throw new Error(`${tarball} contains deleted entrypoint ${stale}`)
  }
}

try {
  mkdirSync(artifacts, { recursive: true })
  mkdirSync(consumer, { recursive: true })
  const thor = pack(join(root, "packages/thor"))
  const cli = pack(join(root, "packages/cli"))
  assertTarball(thor)
  assertTarball(cli)

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        engines: { node: ">=22" }
      },
      null,
      2
    )
  )
  run("npm", ["install", "--ignore-scripts", "effect@^3.21.0", thor, cli], consumer)

  const imports = [
    "@gilvandovieira/thor",
    "@gilvandovieira/thor/schema",
    "@gilvandovieira/thor/sql",
    "@gilvandovieira/thor/postgres",
    "@gilvandovieira/thor/sqlite",
    "@gilvandovieira/thor/mysql",
    "@gilvandovieira/thor/migrate",
    "@gilvandovieira/thor/testing",
    "@gilvandovieira/thor/routine",
    "@gilvandovieira/thor/capabilities"
  ]
  writeFileSync(
    join(consumer, "import-check.mjs"),
    [
      `const modules = ${JSON.stringify(imports)}`,
      "for (const name of modules) {",
      "  const loaded = await import(name)",
      "  if (Object.keys(loaded).length === 0) throw new Error(name + ' has no exports')",
      "}"
    ].join("\n")
  )

  run("node", ["import-check.mjs"], consumer)
  const help = run("node", ["node_modules/@gilvandovieira/cli/dist/index.js", "--help"], consumer)
  if (!help.includes("create <name>")) throw new Error("Packed CLI help is incomplete")
  const capabilities = run(
    "node",
    ["node_modules/@gilvandovieira/cli/dist/index.js", "capabilities", "sqlite"],
    consumer
  )
  if (!capabilities.includes("query.streaming\tunknown")) throw new Error("Packed CLI capability output is incomplete")
  if (capabilities.split("\n").length !== 38) throw new Error("Packed CLI did not print every capability")

  if (process.argv.includes("--bun")) {
    run("bun", ["import-check.mjs"], consumer)
    const bunHelp = run("bun", ["node_modules/@gilvandovieira/cli/dist/index.js", "--help"], consumer)
    if (!bunHelp.includes("create <name>")) throw new Error("Packed CLI does not run under Bun")
    const bunCapabilities = run(
      "bun",
      ["node_modules/@gilvandovieira/cli/dist/index.js", "capabilities", "sqlite"],
      consumer
    )
    if (!bunCapabilities.includes("query.streaming\tunknown"))
      throw new Error("Packed CLI capabilities do not run under Bun")
  }

  const manifest = JSON.parse(readFileSync(join(consumer, "node_modules/@gilvandovieira/thor/package.json"), "utf8"))
  if (manifest.dependencies?.effect) throw new Error("effect must not be duplicated as a direct Thor dependency")
  const cliManifest = JSON.parse(readFileSync(join(consumer, "node_modules/@gilvandovieira/cli/package.json"), "utf8"))
  if (!cliManifest.dependencies?.["@gilvandovieira/thor"])
    throw new Error("CLI must declare Thor as a runtime dependency")
  process.stdout.write(`Package smoke test passed (${process.argv.includes("--bun") ? "Node + Bun" : "Node"}).\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
