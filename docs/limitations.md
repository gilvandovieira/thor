# Thor limitations & maturity

> **Maturity: `0.1.0-alpha.1` (alpha).** The v1 feature surface is largely
> implemented and the completed adversarial remediation has focused regression
> coverage, but streaming is deferred and migration generation, routines,
> relation scaling, and live resource-stress coverage remain partial. Do not treat Thor as
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
- Inline arrays, records, dates, binary views/Buffers, maps, and sets are
  recursively copied when they enter query IR. Frozen opaque domain instances
  are accepted by identity; mutable class instances are rejected because neither
  retaining nor constructor-free cloning can give deterministic semantics. Pass
  those values through named execution parameters instead.
- `.compile()`/`.prepare()` use a **shape-only** model: a query that captures an
  inline value cannot be compiled; use `param(name, schema)` and supply the value
  at `execute()`.
- DML `RETURNING.one()`/`.maybeOne()` request at most two rows from the driver in
  direct, prepared, and compiled modes. node-postgres uses its protocol row
  bound, Node and Bun SQLite stop their statement iterators after two rows, and
  postgres.js uses a two-row cursor then returns `CLOSE`. Structural
  postgres.js/SQLite wrappers that omit the required cursor/iterator reject the
  bounded terminal instead of materializing an unbounded result.
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
  `expand-only`; it requires `allow-reviewed-destructive` plus an explicitly reviewed run — opaque SQL is never silently treated
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
- `SELECT.one()` and `SELECT.maybeOne()` probe at most two rows. DML
  `RETURNING.one()` and `RETURNING.maybeOne()` pass `maxRows: 2` through the
  driver contract, so Thor materializes and decodes at most two returned rows.
  This bounds result consumption; it does not undo the mutation when cardinality
  fails. Use a transaction when that failure must roll the mutation back.

## Prepared statements & pooling

- `PostgresDedicatedPoolConnectionLayer` and
  `MySQLDedicatedPoolConnectionLayer` acquire exactly one pool connection for
  the layer lifetime. They provide affinity, not application-wide per-operation
  pooling. Use separate layer instances for concurrent physical connections.
- `preparedStatements: false` disables prepared execution: mysql2 uses
  `query(sql, values)` instead of `execute(sql, values)`. Bounded query caches
  use an independently configured `preparedMaxSize` (100 by default) to bound
  actual per-connection prepared admission. Entries are leased across driver
  execution and active entries are not evicted. SQLite/mysql2 evictions release
  client resources where their runtimes expose that operation; a MySQL client
  without `unprepare` stops admitting new prepared shapes at the bound and runs
  them unprepared instead. SQLite collision fallbacks and unnamed statements are
  transient and finalized on success or failure when the runtime exposes
  `finalize` or `Symbol.dispose`.

## Relations

- Batched `query` loading uses a dialect-aware native parameter budget capped at
  800 key values per statement. The batch size is
  `floor(availableBudget / keyColumnCount)`. A composite key wider than the
  available budget is rejected before driver execution; it never falls back to
  N+1 or emits an oversized statement. The conservative cap also limits SQLite
  expression depth and practical MySQL packet growth.

## Identifiers

- Thor rejects empty and NUL-bearing identifiers before compilation. Other names
  are opaque single identifiers: quotes/backticks are doubled, while whitespace,
  Unicode, emoji, reserved words, and dots are quoted and permitted. Dots are not
  implicit qualification. Backend byte limits and truncation collisions differ
  by server/object kind and remain backend-enforced; choose portable names and
  use structural schema/name APIs where provided.

## Raw SQL trust boundary

- Structural raw SQL (columns, params, identifiers) is safe. Arbitrary dynamic
  text must pass through `unsafeSql` — including custom window frames, SQL
  defaults, generated/check expressions, and routine type/language/body syntax.
  Prefer the structured window-frame constructors such as `rowsBetween(...)`.
- `SqlStatement` migration values are immutable and authenticated by their
  constructor; structural `{ _tag: "SqlStatement", sql: ... }` objects are
  rejected. Compatible physical package copies in one JavaScript realm share a
  versioned weak authenticity protocol for SQL, statements, columns, params,
  expressions, tables, and routines. Plain/JSON lookalikes remain rejected.
  This protects untrusted data, not hostile same-realm code, which can already
  import Thor and invoke explicit unsafe constructors. Cross-realm and
  incompatible-protocol values require reconstruction.

## Stability classification

See [api-stability.md](./api-stability.md) for `@stable` / `@experimental` /
`@internal` classifications. Internal IR, cache internals, and normalization
helpers are not v1 compatibility commitments even where currently importable.
