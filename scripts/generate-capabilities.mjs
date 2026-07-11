/** Generates the README dialect summary directly from capability metadata. */
import { readFileSync, writeFileSync } from "node:fs"
import {
  ALL_CAPABILITIES,
  MySQLCapabilities,
  PostgresCapabilities,
  SQLiteCapabilities,
  statusOf
} from "../packages/thor/dist/capabilities/index.js"

const start = "<!-- capabilities:generated:start -->"
const end = "<!-- capabilities:generated:end -->"
const matrices = [PostgresCapabilities, SQLiteCapabilities, MySQLCapabilities]
const labels = { postgres: "PostgreSQL", sqlite: "SQLite", mysql: "MySQL 8" }
const statuses = ["native", "emulated", "unsupported", "unknown"]
const rows = matrices.map((matrix) => {
  const counts = Object.fromEntries(
    statuses.map((status) => [
      status,
      ALL_CAPABILITIES.filter((capability) => statusOf(matrix, capability) === status).length
    ])
  )
  return `| ${labels[matrix.dialect]} | ${counts.native} | ${counts.emulated} | ${counts.unsupported} | ${counts.unknown} |`
})
const generated = [
  start,
  "| Dialect | Native | Emulated | Unsupported | Unknown |",
  "|---|---:|---:|---:|---:|",
  ...rows,
  end
].join("\n")

const path = new URL("../README.md", import.meta.url)
const current = readFileSync(path, "utf8")
const pattern = new RegExp(`${start}[\\s\\S]*?${end}`)
if (!pattern.test(current)) throw new Error("README is missing generated capability markers")
const next = current.replace(pattern, generated)

if (process.argv.includes("--check")) {
  if (next !== current)
    throw new Error("README capability summary is stale; run node scripts/generate-capabilities.mjs")
  process.stdout.write("Generated capability summary is current.\n")
} else {
  writeFileSync(path, next)
  process.stdout.write("Updated README capability summary.\n")
}
