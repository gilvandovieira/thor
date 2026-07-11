# @gilvandovieira/cli

Thor's migration and diagnostics CLI. It provides `create`, `generate`,
`check`, `status`, `up`, `down`, `redo`, structural `drift`, live introspection,
`doctor`, capability reporting, and LLM skill export. Benchmark groups are
currently run through the repository `pnpm bench:*` commands; `thor bench` is not
shipped yet.

Connected commands read `thor.config.json`:

```json
{
  "migrationsDir": "migrations",
  "schema": "src/schema.ts",
  "database": { "dialect": "sqlite", "url": "app.db" },
  "policy": "safe-only",
  "journalTable": "_thor_migrations"
}
```

PostgreSQL and MySQL use `pg` and `mysql2` when selected. Schema and migration
TypeScript modules are loaded with `tsx`; migrations must default-export
`defineMigration(...)`. `generate` currently emits additive, irreversible
create-table migrations only. Full column/rename diff generation remains a core
planner follow-up.

Node.js 22 or newer is supported. Run `thor --help` for the shipped command set.
