/**
 * Thor CLI command handlers (spec §13.2).
 *
 * `init`, `create`, `status`, and `check` operate purely on the migrations
 * folder and journal, so they work without a database connection. The
 * DB-connected commands (`up`/`down`/`generate`/...) share the same migration
 * IR and are wired to a live `Database` layer by the host app (Milestone 8).
 *
 * @module cli/commands
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
 * @param cwd - Project root.
 * @param cfg - Resolved CLI config.
 * @returns Applied journal identifiers.
 */
const readJournal = (cwd: string, cfg: ThorConfig): ReadonlyArray<{ id: string }> => {
  const path = journalPath(cwd, cfg)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<{ id: string }>) : []
}

/**
 * @param cwd - Project root.
 * @param cfg - Resolved CLI config.
 * @returns Sorted migration filenames.
 */
const migrationFiles = (cwd: string, cfg: ThorConfig): ReadonlyArray<string> => {
  const dir = join(cwd, cfg.migrationsDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("."))
    .sort()
}

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
 * @param cwd - Project root.
 * @param name - Migration name appended to the timestamp identifier.
 * @returns Nothing.
 * @throws {Error} When `name` is empty.
 */
export const create = (cwd: string, name: string): void => {
  if (!name) throw new Error("Usage: thor create <name>")
  const cfg = loadConfig(cwd)
  const id = `${timestamp()}_${name}`
  mkdirSync(join(cwd, cfg.migrationsDir), { recursive: true })
  const file = join(cwd, cfg.migrationsDir, `${id}.ts`)
  writeFileSync(file, migrationTemplate(id, name))
  log(`Created ${cfg.migrationsDir}/${id}.ts`)
}

/**
 * @param cwd - Project root.
 * @returns Nothing; writes migration status to stdout.
 */
export const status = (cwd: string): void => {
  const cfg = loadConfig(cwd)
  const applied = new Set(readJournal(cwd, cfg).map((e) => e.id))
  const files = migrationFiles(cwd, cfg)
  if (files.length === 0) {
    log("No migrations found.")
    return
  }
  log("Migrations:")
  for (const f of files) {
    const id = f.replace(/\.ts$/, "")
    log(`  ${applied.has(id) ? "✓ applied" : "· pending"}  ${id}`)
  }
  const pending = files.filter((f) => !applied.has(f.replace(/\.ts$/, ""))).length
  log(`\n${applied.size} applied, ${pending} pending.`)
}

/**
 * @param cwd - Project root.
 * @returns Nothing when local migration metadata is valid.
 * @throws {Error} When duplicate or out-of-order migrations are found.
 */
export const check = (cwd: string): void => {
  const cfg = loadConfig(cwd)
  const files = migrationFiles(cwd, cfg)
  const ids = files.map((f) => f.replace(/\.ts$/, ""))
  const seen = new Set<string>()
  const problems: string[] = []
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate migration id: ${id}`)
    seen.add(id)
  }
  const sorted = [...ids].sort()
  if (ids.join() !== sorted.join()) problems.push("migration files are not in lexicographic (timestamp) order")
  if (problems.length > 0) {
    for (const p of problems) log(`✗ ${p}`)
    throw new Error(`check failed with ${problems.length} problem(s)`)
  }
  log(`✓ ${ids.length} migration(s) look valid.`)
}

const NEEDS_DB = "requires a live Database connection (Milestone 8)"

/**
 * @returns Nothing; reports that live generation wiring is pending.
 */
export const generate = (): void => log(`generate: diffs schema vs snapshot and writes a migration — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that live migration wiring is pending.
 */
export const up = (): void => log(`up: applies pending migrations — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that live rollback wiring is pending.
 */
export const down = (): void => log(`down: rolls back the last migration — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that redo wiring is pending.
 */
export const redo = (): void => log(`redo: down then up the last migration — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that live drift wiring is pending.
 */
export const drift = (): void => log(`drift: compares DB state vs expected schema — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that snapshot wiring is pending.
 */
export const snapshot = (): void => log(`snapshot: writes a schema snapshot — ${NEEDS_DB}`)
/**
 * @returns Nothing; reports that schema introspection wiring is pending.
 */
export const pull = (): void => log(`pull: introspects a live DB into schema/snapshot — ${NEEDS_DB}`)
