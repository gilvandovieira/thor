/**
 * CLI database connection and schema loading (spec §20.1).
 *
 * Builds a `Database` layer from configuration and loads the user's
 * schema-as-code through tsx, so `inspect`/`pull`/`introspect`/`drift`/`doctor`
 * can run against a live database. SQLite uses Node's built-in `node:sqlite`;
 * PostgreSQL and MySQL clients (`pg`, `mysql2`) are imported on demand and are
 * optional peer packages.
 *
 * @module cli/database
 */
import { existsSync, readdirSync } from "node:fs"
import { extname, resolve } from "node:path"
import { Effect, type Layer } from "effect"
import type { Database } from "@gilvandovieira/thor"
import { type AnyTable, isTable } from "@gilvandovieira/thor/schema"
import { NodeSQLiteLayer } from "@gilvandovieira/thor/sqlite"
import { PostgresLayer } from "@gilvandovieira/thor/postgres"
import { MySQLLayer } from "@gilvandovieira/thor/mysql"
import { type MigrationDefinition, sqlStatement } from "@gilvandovieira/thor/migrate"

/** Supported CLI database dialects. */
export type DatabaseDialect = "postgres" | "sqlite" | "mysql"

/** Database connection settings from `thor.config.json`. */
export interface DatabaseConfig {
  /** Backend dialect. */
  readonly dialect: DatabaseDialect
  /** Connection string, or SQLite file path (`:memory:` for in-memory). */
  readonly url: string
}

/**
 * Dynamic import with a runtime specifier so optional clients are not resolved at
 * build time.
 *
 * @param name - Module specifier.
 * @returns The imported module namespace.
 */
const importOptional = (name: string): Promise<any> => import(name)

/** A live layer plus its release hook. */
interface OpenDatabase {
  /** The database layer to provide. */
  readonly layer: Layer.Layer<Database>
  /**
   * Release the underlying connection.
   *
   * @returns A promise resolved when the connection is closed.
   */
  readonly close: () => Promise<void>
}

/**
 * Open a database connection and build its `Database` layer.
 *
 * @param config - Connection settings.
 * @returns The layer and a release hook.
 * @throws {Error} When an optional client package is not installed.
 */
const openDatabase = async (config: DatabaseConfig): Promise<OpenDatabase> => {
  switch (config.dialect) {
    case "sqlite": {
      const { DatabaseSync } = await import("node:sqlite")
      const client = new DatabaseSync(config.url)
      return { layer: NodeSQLiteLayer(client as never), close: async () => client.close() }
    }
    case "postgres": {
      const pg = await importOptional("pg").catch(() => {
        throw new Error("PostgreSQL support needs the 'pg' package (npm install pg)")
      })
      const client = new pg.Client({ connectionString: config.url })
      await client.connect()
      return { layer: PostgresLayer(client), close: async () => void (await client.end()) }
    }
    case "mysql": {
      const mysql = await importOptional("mysql2/promise").catch(() => {
        throw new Error("MySQL support needs the 'mysql2' package (npm install mysql2)")
      })
      const connection = await mysql.createConnection(config.url)
      return { layer: MySQLLayer(connection), close: async () => void (await connection.end()) }
    }
  }
}

/**
 * Run an Effect against a freshly opened database, releasing it afterward.
 *
 * @typeParam A - Success value.
 * @typeParam E - Tagged error.
 * @param config - Connection settings.
 * @param effect - Effect requiring the `Database` service.
 * @returns The Effect's result.
 */
export const runWithDatabase = async <A, E>(
  config: DatabaseConfig,
  effect: Effect.Effect<A, E, Database>
): Promise<A> => {
  const { layer, close } = await openDatabase(config)
  try {
    return await Effect.runPromise(Effect.provide(effect, layer))
  } finally {
    await close()
  }
}

/**
 * Load the user's schema-as-code and collect its exported tables (spec §20.1).
 *
 * @param cwd - Project root used to resolve `schemaPath`.
 * @param schemaPath - Path to the schema module (TypeScript is loaded via tsx).
 * @returns Every exported table.
 * @throws {Error} When tsx is unavailable or the module cannot be loaded.
 */
export const loadSchemaTables = async (cwd: string, schemaPath: string): Promise<ReadonlyArray<AnyTable>> => {
  const { tsImport } = await importOptional("tsx/esm/api").catch(() => {
    throw new Error("Loading schema-as-code needs the 'tsx' package")
  })
  const module = await tsImport(resolve(cwd, schemaPath), import.meta.url)
  return Object.values(module).filter(isTable)
}

/** @param value - Unknown module export. @returns Whether it is migration-shaped. */
const isMigration = (value: unknown): value is MigrationDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { name?: unknown }).name === "string" &&
  "up" in value

/**
 * Re-authenticate SQL authored in a tsx module loaded under a separate module identity.
 *
 * @param migration - Migration loaded from the configured source module.
 * @returns A migration whose SQL steps belong to this package identity.
 */
const localizeMigration = (migration: MigrationDefinition): MigrationDefinition => {
  const localize = (step: unknown) => {
    if (
      typeof step === "object" &&
      step !== null &&
      Object.hasOwn(step, "_tag") &&
      Object.hasOwn(step, "sql") &&
      (step as { _tag?: unknown })._tag === "SqlStatement" &&
      typeof (step as { sql?: unknown }).sql === "string"
    ) {
      return sqlStatement((step as { sql: string }).sql)
    }
    return step
  }
  return {
    ...migration,
    up: localize(migration.up),
    ...(migration.down ? { down: localize(migration.down) } : {})
  } as MigrationDefinition
}

/**
 * Loads migration modules in deterministic filename order.
 *
 * @param cwd - Project root.
 * @param migrationsDir - Configured migration directory.
 * @returns Validated migration definitions.
 * @throws {Error} When a module has no valid default migration export.
 */
export const loadMigrations = async (
  cwd: string,
  migrationsDir: string
): Promise<ReadonlyArray<MigrationDefinition>> => {
  const directory = resolve(cwd, migrationsDir)
  if (!existsSync(directory)) return []
  const { tsImport } = await importOptional("tsx/esm/api").catch(() => {
    throw new Error("Loading migrations needs the 'tsx' package")
  })
  const migrations: MigrationDefinition[] = []
  const files = readdirSync(directory)
    .filter((file) => [".js", ".mjs", ".ts"].includes(extname(file)))
    .sort()
  for (const file of files) {
    const module = await tsImport(resolve(directory, file), import.meta.url)
    if (!isMigration(module.default)) throw new Error(`Migration ${file} must default-export defineMigration(...)`)
    migrations.push(localizeMigration(module.default))
  }
  return migrations
}
