# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Thor is an **Effect-native ORM / database toolkit**: fluent schema & query authoring, a typed + runtime IR, per-dialect capability matrices, PostgreSQL/SQLite/MySQL dialects, typed Effect execution, and first-class testing + benchmarks. pnpm workspace, TypeScript 6.0.3 (targeting the TS7 transition), Node ≥20 + Bun.

## Commands

```sh
pnpm install
pnpm build          # tsc -b across packages (project references)
pnpm typecheck
pnpm test           # vitest run — ALL test files (see build gotcha below)
pnpm test:watch
pnpm docs:check     # JSDoc completeness audit — required before submitting src changes
```

Run a **single test** from the repo root (the vitest `include` glob is repo-relative — do not `cd` into a package):

```sh
pnpm exec vitest run compile        # by filename substring
pnpm exec vitest run packages/thor/test/guards.test.ts
pnpm exec vitest run -t "capability" # by test name
```

**End-to-end (real Postgres + MySQL via Docker)** — `*.e2e.test.ts` files, skipped unless `DATABASE_URL`/`MYSQL_URL` are set:

```sh
pnpm e2e            # compose up --wait → build → vitest run e2e → compose down -v
pnpm db:up          # manual: postgres@5433 + mysql@3307
```

**SQLite contract** runs in the default suite (in-memory, no Docker). Bun lane: `pnpm test:contract:sqlite:bun`. Property tests: `pnpm test:property`.

**Benchmarks / perf gate:**

```sh
pnpm bench:hotpath  # cold/warm/prepared/mode axes vs a no-op driver (no DB)
pnpm bench:gate     # fails only on a >2.5× regression vs scripts/hotpath-baseline.json
pnpm bench:baseline # (re)record the baseline
pnpm bench:e2e      # per-driver prepared off/on vs real Postgres
```

## Critical gotchas

- **Tests import the package by name** (`@gilvandovieira/thor`, `/testing`, `/postgres`, …), which resolves via Node self-referencing exports to **`dist`**, not `src`. So **`pnpm build` before running tests after editing source.** The `test:e2e`/`test:contract:*`/`bench:*` scripts build first; bare `pnpm test` does **not**.
- **`minimumReleaseAge: 10080` (7 days, strict)** in `pnpm-workspace.yaml`: new dependencies must be ≥7 days old. Before adding a dep, pin a version published more than a week ago (check `npm view <pkg> time`), or install fails.
- Stale-looking TS diagnostics about the `Dialect` type or missing exports usually mean an editor/LSP lag — trust `pnpm build` / `tsc -b` exit code as ground truth.
- **Every source file and exported declaration needs JSDoc** (`pnpm docs:check` enforces module tags, params, returns, `@throws`); conventions are in `docs/api-documentation.md`.

## Architecture

Two packages under `packages/`: **`@gilvandovieira/thor`** (the toolkit — one flat package with subpath exports `./schema ./sql ./postgres ./sqlite ./mysql ./migrate ./testing ./routine ./capabilities`) and **`@gilvandovieira/cli`** (the `thor` migration CLI binary).

### The execution pipeline (the big picture)

```
Schema DSL → fluent PURE builder → runtime Query IR → guards
   → capability check → Dialect compiler → Effect executor → decode
```

- **Pure builder, Effect executor** (design law): `db.select(...)` and friends return plain immutable query values; only the terminal methods (`all`/`one`/`maybeOne`/`run`) return an `Effect` requiring the `Database` service. IR construction, guards, and compilation are pure — Effect lives only at execution/resource/error boundaries.
- **Runtime IR is the source of truth.** Type-level inference sharpens the API; the runtime `QueryIR` (`ir/`) drives guards, compilation, decoding, and cache keys.

### Two orthogonal seams: Dialect vs Driver

- **`Dialect`** (`src/dialect.ts`) owns SQL rendering (`compileQuery`, quoting, placeholders, comparison), the **capability matrix**, and migration lifecycle SQL. One dialect per backend: `postgres/`, `sqlite/`, `mysql/`.
- **`Driver`** (`execution/driver.ts`) owns transport to a concrete client library and maps native failures to tagged errors. One dialect can back several drivers (e.g. Postgres via node-postgres *and* postgres.js).
- **`Database` service** (`execution/database.ts`, an Effect `Context.Tag`) bundles `dialect` + `driver` + policy (`allowEmulation`, `preparedStatements`, `mode`). Layers like `PostgresLayer(client)` / `SQLiteLayer` / `MySQLLayer` construct it; `FakeDatabaseLayer` (in `testing/`) does so with an in-memory driver.

### Capabilities are executable metadata

`capabilities/` encodes each feature (`insert.returning`, `select.cte`, …) as a **`bigint` bitset** on the hot path, with readable names at the boundary. A dialect declares each capability `native`/`emulated`/`unsupported`/`unknown`; guards fail with a typed `CapabilityError` **before** the driver runs when a required capability isn't satisfied (no silent emulation). **Runtime capabilities** (`capabilities/runtime.ts`, e.g. `runtime.bun`, `runtime.sqlite.bun`) are a separate axis; drivers declare `RuntimeRequirements` and validate them.

### Hot path & caching (`execution/run.ts`)

The runtime pipeline memoizes **compile**, **guard**, and **row-decoder** results per IR shape (WeakMaps keyed by the immutable IR / selection array). Parameterized queries reuse server-side **prepared statements** named by the value-independent `cacheKey`. **Execution modes** (`safe`/`trusted`/`unsafe`) select via `withMode(layer, mode)`: `trusted` skips re-guarding pre-validated shapes; `unsafe` additionally skips decode. `.prepare(name)` produces a `PreparedExecutionPlan` handle that precomputes IR/guard/capabilities/decoder/per-dialect compilation. Cache key = `dialectId : capabilityProfileHash : structuralHash` (never includes values).

### Migrations (`migrate/`)

The **live `Migrator`** (`MigratorLive` layer) runs against a real `Database`: advisory lock, per-step transaction (rolled back on failure), journal with checksums (hard-fail on mismatch), `up`/`down`/`generate`/`apply`/`check`/`drift`. Manual and generated migrations share one migration IR + per-dialect DDL compiler; destructive ops are policy-gated.

### Testing helpers (`testing/`, shipped as `@gilvandovieira/thor/testing`)

Runner-agnostic (inject `describe`/`it`/`expect`): **`FakeDriver`** + `FakeDatabaseLayer` for zero-I/O execution; **`makeDialectContractSuite`** — the capability-aware suite every dialect adapter must pass (native → runs; unsupported → asserts `CapabilityError`); **`defineSqlFeatureSuite` / `runSqlFeatureMatrix` / `runSqlFeatureIntegration`** — the SQL feature matrix run at unit (per-dialect SQL snapshot), fake-execution, and live-integration levels.

## Specs & roadmap

`docs/thor-project-v1-spec.md` is the **current** source of truth (the v0 spec is superseded). `docs/roadmap.md` tracks progress as epics broken into tasks: **Part I (A–J)** closes v0 drift, **Part II (K–W)** is the v1 milestone. When implementing spec features, update the matching roadmap epic's status. Section references throughout the code (`spec §14.11`, etc.) point at these specs.
