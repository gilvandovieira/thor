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
import { dirname, join, resolve } from "node:path"
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
import { SKILLS, skillFiles, type SkillExportFormat } from "@gilvandovieira/thor/skills"
import { detectDrift, makeIntrospector } from "@gilvandovieira/thor/introspect"
import { makeMigrator } from "@gilvandovieira/thor/migrate"
import { Effect } from "effect"
import { type DatabaseConfig, loadSchemaTables, runWithDatabase } from "./database.js"

const CONFIG_FILE = "thor.config.json"

interface ThorConfig {
  readonly migrationsDir: string
  readonly schema: string
  readonly database?: DatabaseConfig
}

const defaultConfig: ThorConfig = { migrationsDir: "migrations", schema: "src/schema.ts" }

/**
 * @param cfg - Resolved CLI config.
 * @returns The configured database settings.
 * @throws {Error} When no `database` is configured.
 */
const requireDatabase = (cfg: ThorConfig): DatabaseConfig => {
  if (!cfg.database) {
    throw new Error(`No database configured. Add a "database" block to ${CONFIG_FILE}: { "dialect": "sqlite", "url": "app.db" }`)
  }
  return cfg.database
}

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

/**
 * @param args - Argument list to search.
 * @param flag - Flag name, e.g. `--to`.
 * @returns The value following `flag`, or `undefined` when absent.
 */
const flagValue = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/**
 * Lists or exports Thor's LLM skills (spec §20.5, §21). `list` prints the skill
 * index; `export` writes the rendered files (Epic U's `skillFiles`) under a
 * target directory.
 *
 * @stable
 * @param cwd - Project root used to resolve a relative `--to` directory.
 * @param args - `list`, or `export [--to <dir>] [--format md|json]`.
 * @returns Nothing.
 * @throws {Error} When the subcommand or `--format` value is invalid.
 */
export const skills = (cwd: string, args: ReadonlyArray<string>): void => {
  const sub = args[0]

  if (sub === "list") {
    const rows = SKILLS.map((skill) => `${skill.id}\t${skill.description}`)
    process.stdout.write(["Skill\tDescription", ...rows, ""].join("\n"))
    return
  }

  if (sub === "export") {
    const rest = args.slice(1)
    const to = flagValue(rest, "--to") ?? ".agents/skills"
    const format = flagValue(rest, "--format") ?? "md"
    if (format !== "md" && format !== "json") {
      throw new Error("Usage: thor skills export [--to <dir>] [--format md|json]")
    }
    // `resolve` honors an absolute `--to`; a relative one is taken from `cwd`.
    const base = resolve(cwd, to)
    const files = skillFiles(format as SkillExportFormat)
    for (const file of files) {
      const target = join(base, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    log(`Exported ${files.length} skill file(s) to ${to}/thor`)
    return
  }

  throw new Error("Usage: thor skills <list|export> [--to <dir>] [--format md|json]")
}

// --- database-connected commands (spec §16.2, §20.1-20.2) --------------------

/**
 * @param cwd - Project root.
 * @returns The live database's introspected Schema IR.
 */
const currentSchema = (cwd: string) =>
  runWithDatabase(requireDatabase(loadConfig(cwd)), Effect.flatMap(makeIntrospector(), (introspector) => introspector.currentSchema()))

/**
 * Introspect the live database and print its Schema IR as JSON (spec §16.2).
 *
 * @stable
 * @param cwd - Project root.
 * @returns Nothing.
 */
export const introspect = async (cwd: string): Promise<void> => {
  log(JSON.stringify(await currentSchema(cwd), null, 2))
}

/**
 * `thor inspect <schema|routines>` (spec §16.2).
 *
 * @stable
 * @param cwd - Project root.
 * @param args - `schema` or `routines`.
 * @returns Nothing.
 * @throws {Error} When the subcommand is missing or unknown.
 */
export const inspect = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
  const sub = args[0]
  if (sub === "schema") return introspect(cwd)
  if (sub === "routines") {
    log("Routine introspection is not available yet; introspection currently covers tables, columns, keys, and indexes.")
    return
  }
  throw new Error("Usage: thor inspect <schema|routines>")
}

/**
 * Write the introspected Schema IR to a JSON snapshot (spec §16.2).
 *
 * @stable
 * @param cwd - Project root.
 * @returns Nothing.
 */
export const pull = async (cwd: string): Promise<void> => {
  const schema = await currentSchema(cwd)
  writeFileSync(join(cwd, "thor.introspected.json"), JSON.stringify(schema, null, 2) + "\n")
  log(`Wrote thor.introspected.json (${schema.tables.length} table(s))`)
}

/**
 * Diff the live database against schema-as-code and report drift (spec §16.5).
 * Exits non-zero when drift is detected.
 *
 * @stable
 * @param cwd - Project root.
 * @returns Nothing.
 */
export const drift = async (cwd: string): Promise<void> => {
  const cfg = loadConfig(cwd)
  const database = requireDatabase(cfg)
  const tables = await loadSchemaTables(cwd, cfg.schema)
  const report = await runWithDatabase(
    database,
    Effect.flatMap(makeIntrospector(), (introspector) => introspector.drift(tables))
  )
  if (report.inSync) {
    log("No drift: the database matches the schema.")
    return
  }
  log(`Drift detected (${report.changes.length}):`)
  for (const change of report.changes) log(`  - ${change.message}`)
  process.exitCode = 1
}

/** One diagnostic line printed by `thor doctor`. */
type Check = { readonly status: "ok" | "warn" | "fail"; readonly name: string; readonly detail: string }

/**
 * Run environment, configuration, connectivity, journal, drift, and capability
 * checks (spec §20.2). Exits non-zero when any check fails.
 *
 * @stable
 * @param cwd - Project root.
 * @returns Nothing.
 */
export const doctor = async (cwd: string): Promise<void> => {
  const checks: Check[] = []
  const add = (status: Check["status"], name: string, detail: string) => checks.push({ status, name, detail })
  const cfg = loadConfig(cwd)

  add("ok", "runtime", detectRuntimeCapabilities().runtime)
  add(existsSync(join(cwd, CONFIG_FILE)) ? "ok" : "warn", "config", existsSync(join(cwd, CONFIG_FILE)) ? CONFIG_FILE : `${CONFIG_FILE} missing (defaults)`)

  if (!cfg.database) {
    add("fail", "database", "no database configured")
  } else {
    add("ok", "dialect", cfg.database.dialect)
    const matrix = DIALECT_CAPABILITIES[cfg.database.dialect]
    if (matrix) {
      const counts = ALL_CAPABILITIES.reduce<Record<string, number>>((acc, capability) => {
        const status = statusOf(matrix, capability)
        acc[status] = (acc[status] ?? 0) + 1
        return acc
      }, {})
      add("ok", "capabilities", Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", "))
    }
    try {
      const tables = await loadSchemaTables(cwd, cfg.schema).catch(() => [] as never)
      const { schema, applied } = await runWithDatabase(
        cfg.database,
        Effect.gen(function* () {
          const introspector = yield* makeIntrospector()
          const migrator = yield* makeMigrator({ schema: tables })
          return { schema: yield* introspector.currentSchema(), applied: yield* migrator.status() }
        })
      )
      add("ok", "connectivity", "connected")
      add("ok", "journal", `${applied.length} applied migration(s)`)
      const report = detectDrift(tables, schema)
      add(report.inSync ? "ok" : "warn", "drift", report.inSync ? "in sync" : `${report.changes.length} change(s)`)
    } catch (error) {
      add("fail", "connectivity", (error as Error).message)
    }
  }

  const icon = { ok: "✓", warn: "!", fail: "✗" } as const
  for (const check of checks) log(`${icon[check.status]} ${check.name}: ${check.detail}`)
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1
}
