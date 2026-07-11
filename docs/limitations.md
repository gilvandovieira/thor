# Thor limitations & maturity

> **Maturity: `0.1.0-alpha.1` (alpha).** The v1 feature surface is largely
> implemented and the release-blocking correctness work is done and tested, but
> streaming is deferred and migration generation, routines, and some
> resource-lifecycle guarantees remain partial. Do not treat Thor as
> production-ready solely because the v1 feature list exists. Reserve `1.0.0`
> for a deliberate stable release after external application use.

This document records what Thor does **not** yet do, or does only partially, so
the promises it makes are accurate. It complements [dialects.md](./dialects.md),
[migrations.md](./migrations.md), and [api-stability.md](./api-stability.md).

## Conformance matrix

Each feature is tracked by conformance level rather than a binary "done". Legend:
**I** implemented · **U** unit/pure-tested · **F** fake-driver-tested ·
**S** live-SQLite · **P** live-PostgreSQL · **M** live-MySQL · **N** Node ·
**B** Bun · **D** documented · **St** API-stable. A cell is ✅ met, 🟡 partial,
⬜ not yet, — not applicable. "Live" columns are exercised by the Docker e2e lane.

| Feature | I | U | F | S | P | M | N | B | D | St | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Query builder | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | pure IR; degenerate shapes rejected |
| Parameters & encoding | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | inline≡named codec; branded inputs |
| Compiled/prepared queries | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | shape-only; `PreparedQuery` experimental |
| Relations (explicit load) | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | ✅ | 🟡 | no hidden N+1; experimental |
| Transactions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | savepoints, typed causes |
| Migrations (manual exec) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | policy-governed up/down |
| Migration generation | 🟡 | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ⬜ | ✅ | 🟡 | create-table only |
| Introspection | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | schema/index pull |
| Drift | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | structural vs legacy split |
| Routines | 🟡 | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | ✅ | 🟡 | advanced args deferred |
| Observability | ✅ | ✅ | ✅ | — | — | — | ✅ | 🟡 | ✅ | ✅ | spans/logs/metrics |
| PostgreSQL | ✅ | ✅ | ✅ | — | ✅ | — | ✅ | 🟡 | ✅ | ✅ | node-postgres + postgres.js |
| SQLite | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | node:sqlite + bun:sqlite |
| MySQL | 🟡 | ✅ | ✅ | — | — | ✅ | ✅ | 🟡 | ✅ | 🟡 | non-transactional DDL |
| CLI | ✅ | ✅ | — | 🟡 | 🟡 | 🟡 | ✅ | ⬜ | ✅ | ✅ | 15 stable commands |
| Skills | ✅ | ✅ | — | — | — | — | ✅ | ⬜ | ✅ | 🟡 | 10 SKILL.md, generated |
| Package publishing | ✅ | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ | packed Node+Bun consumer |

A feature is not marked stable (`St`) unless its API surface is in
[api-manifest.json](./api-manifest.json) at `@stable`.

## Runtime & database support

- **Node** ≥ 22 and **Bun** are the supported runtimes. SQLite runs on
  `node:sqlite` (Node) and `bun:sqlite` (Bun); both are exercised by the driver
  contract suite.
- **PostgreSQL** is supported via `node-postgres` and `postgres.js`.
- **MySQL** support is **partial** — see the MySQL notes below.

## Query builder & parameters

- Multi-row inserts are homogeneous: every row must describe the same set of
  application keys as the first row. Unknown keys, and later rows with
  missing/extra keys, are rejected with a tagged `ParameterError` at construction
  (they are **not** silently dropped or misaligned). <a id="params"></a>
- Every application value — inline (`eq(col, x)`) or named (`param(...)`) — is
  validated and encoded through its declared codec before reaching the driver.
- `.compile()`/`.prepare()` use a **shape-only** model: a query that captures an
  inline value cannot be compiled; use `param(name, schema)` and supply the value
  at `execute()`.
- `limit`/`offset` must be finite, non-negative safe integers; other values are
  rejected before any IR is built.
- Empty `inArray`/`or` lower to `FALSE`; empty `notInArray`/`and` lower to `TRUE`.

## Migrations <a id="migrations"></a>

- **Generation is create-table-only.** `generate()` emits `CREATE TABLE` DDL from
  the schema diff. It does **not** yet generate column alterations, index/constraint
  changes, enum/view handling, or identity/generated-column changes. Use manual
  migrations for those.
- **Manual-migration safety is author-declared.** Thor cannot infer safety from
  opaque `sql`/`rawSql` text. `up()` is guarded by `safety`/`phase` and `down()`
  independently by `downSafety`/`downPhase`. A migration with **no declared
  `safety`** is treated as *unchecked* and **blocked** under `safe-only`/
  `expand-only` unless the run is reviewed — opaque SQL is never silently treated
  as safe. Declare `safety: "additive"` on additive migrations (the CLI templates
  do this for you). The whole pending set is preflighted before the first step
  runs.
- Policy rejection happens before any SQL reaches the driver, inside the migration
  lock/transaction, so the journal is never written for a blocked step.
- Transactional DDL differs by dialect; MySQL applies DDL non-transactionally and
  can leave partial progress on failure of a multi-statement step.
- New journal rows use `sha256:v1:<digest>` over canonical execution-relevant
  migration metadata. Existing eight-character FNV-1a rows remain verifiable and
  are not silently rewritten; unknown versioned algorithms fail clearly.

## Drift & introspection

- Introspector drift and Migrator "schema change" detection are **not the same
  guarantee**. Introspection compares tables/columns/nullability/keys/indexes;
  the migrator's schema reconciliation is create-table oriented. Check the API
  you call for its exact comparison scope.

## Routines

- Scalar/aggregate/window function calls and basic procedures are supported.
  Advanced named/OUT-argument binding, default arguments, overload resolution,
  and routine introspection are **partial or deferred** — verify against the
  routine tests before depending on them.

## Streaming

- There is **no `stream()` terminal**. Streaming is deferred out of v1: the
  `query.streaming` capability is `unsupported` on every dialect, and no scoped
  cursor driver contract exists. Use `.all()` with explicit pagination until a
  cursor-backed, interruptible streaming API ships.

## Prepared statements & pooling

- `PostgresDedicatedPoolConnectionLayer` and
  `MySQLDedicatedPoolConnectionLayer` acquire exactly one pool connection for
  the layer lifetime. They provide affinity, not application-wide per-operation
  pooling. Use separate layer instances for concurrent physical connections.
- `preparedStatements: false` disables prepared execution: mysql2 uses
  `query(sql, values)` instead of `execute(sql, values)`. Bounded query caches
  also bound actual per-connection prepared admission; SQLite/mysql2 evictions
  release client resources where their runtimes expose that operation.

## Raw SQL trust boundary

- Structural raw SQL (columns, params, identifiers) is safe. Arbitrary dynamic
  text must pass through `unsafeSql` — including custom window frames, SQL
  defaults, generated/check expressions, and routine type/language/body syntax.
  Prefer the structured window-frame constructors such as `rowsBetween(...)`.

## Stability classification

See [api-stability.md](./api-stability.md) for `@stable` / `@experimental` /
`@internal` classifications. Internal IR, cache internals, and normalization
helpers are not v1 compatibility commitments even where currently importable.
