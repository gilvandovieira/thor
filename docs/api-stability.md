# API stability

Thor tags its public API with one of three levels (spec §6), carried as JSDoc
tags in the source and enforced by `scripts/check-api-stability.mjs` (part of
`pnpm docs:check`). The tag on a declaration is the contract; it cannot drift
silently.

## Levels

- **`@stable`** — the supported public surface. Breaking changes are a semver
  major and called out in the changelog.
- **`@experimental`** — shipped and usable, but the shape may change in a minor
  while it settles. Opt in deliberately.
- **`@internal`** — implementation detail. Not part of the public contract even
  though it may be reachable; do not depend on its shape.

## Stable

The schema DSL, query builder, execution methods, compiled query, migration
format, tagged errors, capability names, dialect/driver interfaces, testing
helpers, and the shipped CLI commands:

- Schema: `Column`, `defineTable`, `Select`/`Insert`/`Update`, `pg`/`sqlite`/`mysql`
- Query: `db`, `SelectQuery`, `ReturningQuery`, `QueryReference`, and the terminal
  methods `all`/`one`/`maybeOne`/`run`
- Compiled query: `CompiledQuery`, `CompileOptions`, and `execute`/`compile`/`compilePrepared`
- Caching: `withQueryCache`
- Migrations: `defineMigration`, `MigrationDefinition`, `Migrator`, `MigratorService`, `MigrationPlan`
- Errors: `ThorError` (and every tag — see [errors](errors.md))
- Capabilities: `Capability`, `ALL_CAPABILITIES`
- Dialect/driver: `Dialect`, `Driver`
- Testing: `FakeDriver`, `FakeDatabaseLayer`, `expectSql`
- Observability: `ObservabilityOptions`, `withObservability`
- CLI: `init`, `create`, `generate`, `check`, `status`, `up`, `down`, `redo`,
  `drift`, `pull`, `introspect`, `inspect`, `doctor`, `capabilities`, and `skills`

## Experimental

APIs still settling — usable, but the shape may change:

- `PreparedQuery` (the v0 named multi-dialect handle; prefer the stable
  `CompiledQuery` for one known dialect)
- `withMode` (execution modes, including `unsafe-hot`)
- `RuntimeCapabilityProfile`, `detectRuntimeCapabilities` (runtime lanes)
- `makeDialectContractSuite` (adapter contract suite)
- The relation layer (`defineRelations`, `one`/`many`, `withRelations`, …) and the
  LLM skills export are marked `@experimental` at their declarations

## Internal

Reachable but not contractual — do not depend on these shapes:

- `QueryIR` and the IR node types
- `QueryCaches` and the cache-layer internals

## `inspect()` is stable-for-debug only

`query.inspect()` and `CompiledQuery` metadata (`cacheKey`, `capabilities`, …)
are stable for **debugging and diagnostics** — their presence and rough shape
won't disappear — but the exact contents are advisory. Do not build production
logic on the precise structure of `inspect()`; use the typed query results,
tagged errors, and capability checks for behavior.
