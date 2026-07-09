# Repository Guidelines

## Project Structure & Module Organization

Thor is a pnpm workspace for an Effect-native TypeScript database toolkit. `packages/thor/src/` contains the core library, organized by concern (`schema/`, `sql/`, `execution/`, `migrate/`) and database adapter (`postgres/`, `sqlite/`, `mysql/`). Vitest suites live in `packages/thor/test/`; Bun contract tests are in `test-bun/`, and benchmarks are in `scripts/`. `packages/cli/src/` implements the migration CLI. Shared configuration is at the root; design notes and the current v1 specification live in `docs/`.

## Build, Test, and Development Commands

- `pnpm install` installs all workspace dependencies (Node 20+; pnpm 11.3.0).
- `pnpm build` compiles all packages with TypeScript project references.
- `pnpm typecheck` runs strict type checking without emitting files.
- `pnpm docs:check` verifies required source and exported-declaration JSDoc.
- `pnpm test` runs the Vitest suite; build first because tests resolve package exports from `dist/`.
- `pnpm exec vitest run packages/thor/test/compile.test.ts` runs one test file from the repository root.
- `pnpm test:property` runs fast-check property tests; `pnpm test:contract:sqlite:bun` covers the Bun lane.
- `pnpm e2e` starts Dockerized PostgreSQL/MySQL, runs end-to-end tests, and removes the containers.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, extensionless package imports, and strict compiler-safe types. Prefer immutable, pure query-building code; introduce Effect only at execution, resource, and error boundaries. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive kebab-case module names such as `structural-hash.ts`. Test files use `*.test.ts`; real-database tests use `*.e2e.test.ts`. Add module and API JSDoc following `docs/api-documentation.md`. No standalone formatter or linter is configured, so match nearby code.

## Testing Guidelines

Use Vitest with explicit imports (`globals: false`). Add focused unit tests beside the relevant suite and cover each supported dialect when SQL or capabilities change. Use `FakeDriver` for zero-I/O execution tests and Docker only for integration behavior. Run `pnpm build && pnpm test && pnpm docs:check` before submitting source changes.

## Commit & Pull Request Guidelines

History follows concise Conventional Commit subjects, for example `feat: wire declared routines into query execution` and `test: cover advanced SQL features`. Keep commits scoped and imperative. Pull requests should explain behavior and rationale, link relevant issues/spec sections, list verification commands, and call out dialect, migration, or performance impact. Include screenshots only for user-visible documentation or CLI output changes.

## Security & Configuration Tips

Do not commit credentials or local database data. Use the documented local Docker URLs via environment variables. New dependencies must satisfy the workspace's strict seven-day minimum release age.
