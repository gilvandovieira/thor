# Introspection and structural drift

Thor reads a live PostgreSQL, SQLite, or MySQL database into a dialect-neutral
Schema IR. The same IR powers inspection, JSON snapshots, structural drift
checks, migration preflight checks, and `thor doctor`. Introspection verifies
schema-as-code; it does not replace the schema module or generate executable
application types.

## Public API

Import the introspection API from its published subpath:

```ts
import {
  Introspector,
  IntrospectorLive,
  detectDrift,
  makeIntrospector,
  type DriftReport,
  type IntrospectedSchema
} from "@gilvandovieira/thor/introspect"
```

`makeIntrospector()` requires an ambient `Database` and returns a reusable
service. `currentSchema()` reads the database, while `drift(expected, options?)`
reads it and compares the result with schema-as-code tables:

```ts
import { Effect, Layer } from "effect"
import { makeIntrospector } from "@gilvandovieira/thor/introspect"

const inspect = Effect.gen(function* () {
  const introspector = yield* makeIntrospector()

  const current = yield* introspector.currentSchema()
  const report = yield* introspector.drift([users, posts])

  return { current, report }
})
```

Provide `inspect` with the same database layer used by queries and migrations.
For dependency-injected applications, `IntrospectorLive` provides the
`Introspector` context tag over an existing `Database` layer:

```ts
const inspect = Effect.gen(function* () {
  const introspector = yield* Introspector
  return yield* introspector.currentSchema()
})

const runnable = inspect.pipe(
  Effect.provide(IntrospectorLive.pipe(Layer.provide(databaseLayer)))
)
```

`currentSchema()` returns `{ tables }`, ordered by table name. Each table has
ordered columns, primary-key columns, foreign keys, and secondary indexes.
Columns retain the database's raw type text and default expression. Foreign-key
actions are normalized to lower case, with the implicit `no action` omitted.

`detectDrift(expected, live, options?)` is the pure equivalent when a caller
already has an `IntrospectedSchema`. Both it and `Introspector.drift()` return a
`DriftReport` with `inSync` and an ordered `changes` array.

`Migrator.drift()` is a legacy, differently shaped API: it returns only
`CreateTable` operations for expected tables missing from the database. It is
not structural drift and should not be used for diagnostics or reconciliation;
prefer `Introspector.drift()`.

## Structural scope

Drift currently reports:

- missing and extra tables;
- missing and extra columns;
- changed column nullability;
- changed primary-key columns or order;
- missing and extra foreign keys;
- missing, extra, or changed indexes, including column order and uniqueness.

The default drift options ignore `_thor_migrations` as an extra live table, so
Thor's migration journal does not create permanent drift. For a custom journal
name, pass it explicitly in programmatic checks:

```ts
const report = yield* introspector.drift(schema, {
  ignoreTables: ["app_migration_journal"]
})
```

Introspection records column types and defaults, but drift does not compare
them. SQLite affinity is lossy: distinct logical declarations such as UUID,
text, and timestamp can all be represented as `TEXT`. Comparing raw type text
across schema-as-code and every backend would therefore produce false drift.
Default-expression drift is likewise outside the current reliable structural
comparison.

The current Schema IR is limited to objects represented by Thor's schema DSL.
Views, enums, routines, and extensions are catalog follow-up work rather than
drift inputs. `thor pull` currently records the modeled table IR only; it is not
yet a complete database-catalog export.

## CLI configuration

Connected commands read `thor.config.json` from the current project directory:

```json
{
  "migrationsDir": "migrations",
  "schema": "src/schema.ts",
  "database": {
    "dialect": "sqlite",
    "url": "app.db"
  },
  "journalTable": "_thor_migrations"
}
```

Use `postgres`, `sqlite`, or `mysql` as the dialect. SQLite's `url` is a file
path or `:memory:`. PostgreSQL and MySQL URLs are connection strings and require
the optional `pg` or `mysql2` client respectively. Schema modules are loaded
through `tsx`, and all exported Thor tables are used for drift. Commands fail
when no database is configured or when connection, schema loading, or catalog
queries fail.

## CLI commands

```sh
thor introspect
thor inspect schema
thor inspect routines
thor pull
thor drift
thor doctor
```

- `thor introspect` prints the live Schema IR as formatted JSON.
- `thor inspect schema` is an alias for `thor introspect`.
- `thor inspect routines` reports that routine introspection is not available
  yet; it does not query or print routines.
- `thor pull` overwrites `thor.introspected.json` with the formatted live Schema
  IR and reports the table count. Review the snapshot before committing it.
- `thor drift` loads the configured schema module, compares it with the live
  database, prints each structural change, and sets a non-zero exit status when
  drift exists.
- `thor doctor` checks runtime, configuration, dialect capabilities, schema
  loading, connectivity, migration journal validity, pending migrations,
  runtime compatibility, and drift. Any failed check sets a non-zero exit
  status.

Migration execution also uses introspection as a preflight. `thor up` blocks
when structural drift remains and no migration is pending. When migrations are
pending, it warns instead because the pending DDL may explain the difference.
This check uses the configured `journalTable` as its ignored table.

The `up`, `drift`, and `doctor` CLI paths all ignore the configured
`journalTable`, including custom names.

## Dialect strategy and performance

PostgreSQL reads the `public` schema and MySQL reads the current database. Each
uses five set-based catalog queries: base tables, columns, primary keys, foreign
keys, and indexes. The result is assembled in memory, avoiding a query per table
for those dialects.

SQLite has no equivalent set-based `information_schema`. It first lists user
tables from `sqlite_schema`, then uses `pragma table_info`,
`pragma foreign_key_list`, and `pragma index_list` per table, plus
`pragma index_info` per explicit index. Runtime therefore scales with the number
of SQLite tables and indexes. Discovered SQLite identifiers are double-quoted
and embedded quotes are escaped.

PostgreSQL excludes primary-key and constraint-backed indexes from secondary
indexes. SQLite includes explicitly created indexes and excludes primary-key or
unique-constraint backing indexes. MySQL's catalog can expose indexes backing
unique or foreign-key constraints, which is a backend catalog distinction to
consider when interpreting index drift.

## Testing live introspection

The unit suites exercise PostgreSQL, SQLite, and MySQL catalog parsing with the
`FakeDriver`, including the fixed five-query PostgreSQL path. Live tests use an
in-memory `node:sqlite` database to create tables through the migrator and then
verify columns, keys, indexes, and both in-sync and changed-schema drift. CLI
subprocess tests use a real SQLite file for `inspect schema`, `pull`, `drift`,
`doctor`, and migration preflight behavior.

Live PostgreSQL and MySQL introspection should be validated in the repository's
database E2E lane when changing their catalog SQL. Fake-driver tests protect row
mapping and query shape, but cannot detect server-version catalog differences,
permissions, collation behavior, or real client decoding.

## Safety

Catalog introspection and drift are read-only: they issue `SELECT` or `PRAGMA`
queries and never apply DDL. `thor pull` is the only introspection command that
deliberately writes a snapshot, at `thor.introspected.json`. However, opening a
missing SQLite file can create it, and `doctor` may create the migration journal
through the migrator's journal check when it does not exist.

The CLI imports the configured schema module through `tsx`; normal module
top-level code therefore runs. Only point `schema` at trusted project code, and
use database credentials whose catalog access and write permissions match the
command being run.

Treat introspected defaults and type strings as untrusted database metadata.
They are serialized for inspection, not executed by the introspector. Drift is
diagnostic rather than a migration plan: review differences and use explicit,
policy-checked migrations instead of translating live metadata directly into
DDL.
