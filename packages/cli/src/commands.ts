/**
 * Thor CLI command handlers (spec §13.2, v1 §20.3).
 *
 * Filesystem-safe migration scaffolding and static dialect capability reporting
 * are available without opening a database connection. Database-connected
 * operations remain available through the programmatic migrator.
 *
 * @module cli/commands
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALL_CAPABILITIES,
  ALL_RUNTIME_CAPABILITIES,
  MySQLCapabilities,
  PostgresCapabilities,
  SQLiteCapabilities,
  detectRuntimeCapabilities,
  statusOf,
  type CapabilityMatrix
} from "@gilvandovieira/thor/capabilities"

const CONFIG_FILE = "thor.config.json"

interface ThorConfig {
  readonly migrationsDir: string
  readonly schema: string
}

const defaultConfig: ThorConfig = { migrationsDir: "migrations", schema: "src/schema.ts" }

/**
 * @param cwd - Project working directory.
 * @returns Merged CLI configuration.
 */
const loadConfig = (cwd: string): ThorConfig => {
  const path = join(cwd, CONFIG_FILE)
  if (!existsSync(path)) return defaultConfig
  return { ...defaultConfig, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ThorConfig>) }
}

/**
 * @param cwd - Project root.
 * @param cfg - Resolved CLI config.
 * @returns Journal JSON path.
 */
const journalPath = (cwd: string, cfg: ThorConfig) => join(cwd, cfg.migrationsDir, "meta", "journal.json")

/**
 * @returns Local timestamp suitable for sortable migration identifiers.
 */
const timestamp = (): string => {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * @param id - Migration identifier.
 * @param name - Human-readable name.
 * @returns TypeScript migration template.
 */
const migrationTemplate = (id: string, name: string): string =>
  `import { defineMigration, sql } from "@gilvandovieira/thor/migrate"

export default defineMigration({
  id: "${id}",
  name: "${name}",

  up: sql\`
    -- write your forward migration here
  \`,

  down: sql\`
    -- write the rollback here
  \`
})
`

/**
 * @param msg - Line written to standard output.
 * @returns Nothing.
 */
const log = (msg: string): void => {
  process.stdout.write(msg + "\n")
}

// --- commands ----------------------------------------------------------------

/**
 * @stable
 * @param cwd - Project root to initialize.
 * @returns Nothing.
 */
export const init = (cwd: string): void => {
  const cfg = defaultConfig
  const configPath = join(cwd, CONFIG_FILE)
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n")
  mkdirSync(join(cwd, cfg.migrationsDir, "meta"), { recursive: true })
  const jPath = journalPath(cwd, cfg)
  if (!existsSync(jPath)) writeFileSync(jPath, "[]\n")
  log(`Initialized Thor: ${CONFIG_FILE}, ${cfg.migrationsDir}/, ${cfg.migrationsDir}/meta/journal.json`)
}

/**
 * @stable
 * @param cwd - Project root.
 * @param name - Migration name appended to the timestamp identifier.
 * @returns Nothing.
 * @throws {Error} When `name` is empty.
 */
export const create = (cwd: string, name: string): void => {
  if (!name) throw new Error("Usage: thor create <name>")
  if (!/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(name)) {
    throw new Error("Migration name must start with a lowercase letter and contain only lowercase letters, numbers, '_' or '-'")
  }
  const cfg = loadConfig(cwd)
  const id = `${timestamp()}_${name}`
  mkdirSync(join(cwd, cfg.migrationsDir), { recursive: true })
  const file = join(cwd, cfg.migrationsDir, `${id}.ts`)
  writeFileSync(file, migrationTemplate(id, name))
  log(`Created ${cfg.migrationsDir}/${id}.ts`)
}

const DIALECT_CAPABILITIES: Readonly<Record<string, CapabilityMatrix>> = {
  postgres: PostgresCapabilities,
  sqlite: SQLiteCapabilities,
  mysql: MySQLCapabilities
}

/**
 * Prints every declared capability status for a built-in SQL dialect, or — with
 * the `runtime` target — the current JavaScript host's detected runtime
 * capabilities (spec §20.3).
 *
 * @stable
 * @param args - Exactly one target: `postgres`, `sqlite`, `mysql`, or `runtime`.
 * @returns Nothing.
 * @throws {Error} When the target argument is missing, extra, or unknown.
 */
export const capabilities = (args: ReadonlyArray<string>): void => {
  if (args.length !== 1) throw new Error("Usage: thor capabilities <postgres|sqlite|mysql|runtime>")
  const target = args[0]!

  if (target === "runtime") {
    // Runtime capabilities are present or absent (never emulated); report them as
    // native/unsupported for the detected host.
    const profile = detectRuntimeCapabilities()
    const rows = ALL_RUNTIME_CAPABILITIES.map(
      (capability) => `${capability}\t${profile.capabilities.has(capability) ? "native" : "unsupported"}`
    )
    process.stdout.write([`Runtime: ${profile.runtime}`, "Capability\tStatus", ...rows, ""].join("\n"))
    return
  }

  const matrix = DIALECT_CAPABILITIES[target]
  if (!matrix) throw new Error(`Unknown target: ${target}. Expected one of: postgres, sqlite, mysql, runtime.`)

  const rows = ALL_CAPABILITIES.map((capability) => `${capability}\t${statusOf(matrix, capability)}`)
  process.stdout.write([`Dialect: ${target}`, "Capability\tStatus", ...rows, ""].join("\n"))
}
