# Thor roadmap — closing the drift to spec v0

Source of truth: [`thor-project-spec-v0.md`](./thor-project-spec-v0.md).
This roadmap breaks every item flagged in the drift review into concrete tasks so
the implementation matches the specification.

**Status legend:** ✅ done · 🟡 partial · ❌ missing
**Priority:** P0 (blocking correctness/spec-validity) · P1 (core v0) · P2 (hardening/nice-to-have)
**Effort:** S (<½ day) · M (½–2 days) · L (>2 days)

## Epic overview

| Epic | Theme | Spec | Current | Priority |
|---|---|---|---|---|
| A | Documentation alignment | §2, §14, §15 | ✅ A1–A5 | P0 |
| B | Multi-dialect contract-suite coverage | §2A.1, §18.6 | ✅ B1–B5 | P1 |
| C | Runtime portability & capabilities (Bun) | §2A.2, §2A.3, §18.7 | ✅ C1–C4 | P1 |
| D | Precompiled static query handles (`.prepare()`) | §15.13, §15.15, M7 | ✅ D1–D6 | P1 |
| E | Performance modes (safe/trusted/unsafe) | §15.13, §15.17 | ✅ E1–E5 | P2 |
| F | Cache-key composition & optimization strategies | §15.14 | ✅ F1–F4 | P1 |
| G | SQL feature matrix tests | §14.11, M6 | ✅ G1–G5,G6b · 🟡 G6a | P1 |
| H | Property & fuzz tests | §14.12, M6 | ✅ H1–H5 | P2 |
| I | Performance benchmarks, targets & CI gates | §15.12, §15.16, §18.8/18.9, M7 | ✅ I1–I7 | P1 |
| J | Advanced query features (joins/agg/CTE/window/upsert) | §6, §14.11 L3–5,7 | ✅ J1–J5 | P2 |

## Sequencing (phases)

```
Phase 0  A (docs)                     — unblock nothing, cheap, do first
Phase 1  F (cache key) → D (handles)  ⟶ B (contract suite: all dialects)
         C.1 (runtime caps model)
Phase 2  E (perf modes)  ⟵ D,F        ⟶ I (bench lanes, cache-hit/handle, gates)
Phase 3  G (feature matrix) ⟵ B       ⟶ H (property/fuzz)
Phase 4  C.2 (Bun contract lane) ⟵ B  — closes runtime-portability invariant
Phase 5  J (joins/agg/CTE/window)     → unblocks G6b + H5b (the deadlock's real prerequisite)
```

> **G6/H5 deadlock (resolved).** G6b (feature Levels 3–5) and H5b (join fuzzing)
> were framed as waiting on each other; both actually depend on **Epic J**
> (join/aggregation/CTE/window IR + compiler), which no epic owned. J now owns
> that prerequisite, so the graph is acyclic — J → {G6b, H5b} — and G6a/H5a
> proceed immediately with today's IR.

---

## Epic A — Documentation alignment (P0)

| # | Status | Task | Spec | Effort | Acceptance |
|---|---|---|---|---|---|
| A1 | ✅ | Repoint README to the v0 spec; consolidate the two v0 spec drafts | — | S | The original and "updated" v0 drafts were merged into a single [`thor-project-spec-v0.md`](./thor-project-spec-v0.md); README and this roadmap link it as the v0 source of truth |
| A2 | ✅ | Refresh README milestone table | M0–M9 | S | M6 reflects the partial feature/fuzz matrix; M7 names Node/Bun lanes, the prepared-handle benchmark, 1–2 µs tracking, and CI regression gate; cross-cutting dialect/runtime/mode rows are explicit |
| A3 | ✅ | Scope the "contract suite" claim in README/benchmarks | §2A.1, §18.6 | S | README distinguishes the identical suite across two Postgres drivers, Node/Bun SQLite, and MySQL from the Postgres-only cross-driver benchmark and documents their separate CI lanes |
| A4 | ✅ | Update `driver-benchmarks.md` for perf modes + static handles | §15.13, §15.15 | S | Headline and scope call out unprepared results; the doc distinguishes server preparation from `.prepare()` and points historical pre-handle numbers to current handle/mode measurements |
| A5 | ✅ resolved | Report the spec's duplicate `§14.11` numbering | §14.11 | S | The correction is incorporated in the current source of truth: feature matrix §14.11, property tests §14.12, migration tests §14.13; the superseded spec retains migration tests at its historical §14.11 |

**Definition of done:** no doc contradicts the v0 spec; every incomplete
area is labeled 🟡 with its remaining work rather than claimed complete. ✅

---

## Epic B — Multi-dialect contract-suite coverage (P1)

> §2A.1: "A dialect adapter is valid only when it declares a capability matrix **and passes the shared capability-aware dialect contract suite**." Done for Postgres (node-postgres + postgres.js), SQLite (`node:sqlite`), and MySQL (`mysql2`).

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| B1 | ✅ | Make the contract suite **capability-aware** | §14.11 | `makeDialectContractSuite` gates `RETURNING` by the dialect matrix: native → runs & asserts result; unsupported → asserts `CapabilityError` before the driver. Verified: MySQL (`*.returning: unsupported`) hits the CapabilityError branch |
| B2 | ✅ | Wire the suite for **SQLite** (`node:sqlite`) | §2A.1, §2A.2 | `sqlite.contract.test.ts` runs the full suite in-memory in the **default** test run (no Docker) — 9/9 green. The separate Bun harness reuses the same suite and fixture under C3 |
| B3 | ✅ | Wire the suite for **MySQL** (`mysql2/promise`, Dockerized) | §2A.1 | `docker-compose` adds MySQL 8.4; `mysql.e2e.test.ts` runs the suite over a single connection — 9/9 green; `RETURNING` asserts `CapabilityError` |
| B4 | ✅ | Per-suite **test isolation** | §18.6 | `beforeEach` runs dialect-specific reset DDL; each dialect owns its DB/connection; no cross-test leakage |
| B5 | ✅ | CI matrix runs all three dialects via Effect Layers | §18.6 | `.github/workflows/ci.yml` runs SQLite in the Node job and the shared suite against live Postgres+MySQL services in the e2e job |

**Definition of done:** every shipped dialect passes the identical, capability-aware suite; unsupported features fail before the driver. ✅ (verified: `pnpm e2e` → 35 tests across Postgres/MySQL; `pnpm test` → SQLite 9/9)

---

## Epic C — Runtime portability & capabilities (P1)

| # | Status | Task | Spec | Effort | Acceptance |
|---|---|---|---|---|---|
| C1 | ✅ | Model **runtime capabilities** | §2A.3 | M | `capabilities/runtime.ts` models Node, Bun, crypto, filesystem, process, test-runner, SQLite, and N-API capabilities with injectable detection |
| C2 | ✅ | Adapters **declare required runtime caps** | §18.7 | S | `Driver.runtime` is mandatory; Node/Bun SQLite adapters validate their requirements and throw `RuntimeCapabilityError` before use |
| C3 | ✅ | Run the **contract suite under Bun** in CI | §2A.2, §18.7 | M | The Bun CI job runs the explicit `bun:test` + `bun:sqlite` harness against the same suite and fixture as Node |
| C4 | ✅ declined | (Optional) `@thor/node` / `@thor/bun` subpaths | §2A.2 | S | Runtime-specific SQLite entry points live under `/sqlite`; top-level runtime subpaths would duplicate the dialect API without adding a useful boundary |

**Definition of done:** "runtime support is valid only when the adapter passes the shared contract suite under that runtime" holds for Node and Bun.

---

## Epic D — Precompiled static query handles `.prepare()` (P1)

> §15.15: a prepared handle precomputes normalized IR, guard result, required capabilities, structural hash, compiled SQL per dialect, param order, decoder plan, and tracing metadata.

| # | Status | Task | Spec | Effort | Acceptance |
|---|---|---|---|---|---|
| D1 | ✅ | `PreparedQuery` type + `.prepare(name)` on Select/Returning builders | §15.13/15.15 | M | Public `PreparedQuery`; select and returning builders produce reusable named handles |
| D2 | ✅ | Precompute IR + guard + capabilities + structural hash at prepare time | §15.15 | M | Handle snapshots IR and precomputes shape guard, capability bits, parameter order, tracing metadata, and a value-independent structural hash |
| D3 | ✅ | Compile-once-per-dialect cache inside the handle | §15.15 | S | Per-handle cache keys compilation by dialect object and capability-profile hash; repeated `toSql`/execution reuses it |
| D4 | ✅ | Precompute the **decoder plan** on the handle | §15.8/15.15 | S | Row decoder is built in the plan constructor and passed directly to prepared execution |
| D5 | ✅ | Execution methods on the handle (`one/all/maybeOne/run`) | §15.13 | S | Handles preserve Effect return types and bind named values separately for each call |
| D6 | ✅ | Handle honors performance correctness rules | §15.17 | S | Inline values are rejected; handles retain no layer/transaction; capability outcomes are cached per dialect profile and emulation policy |

**Definition of done:** hot paths can hoist a handle to module scope; repeated execution pays only bind + drive + decode (benchmarked in I3).

---

## Epic E — Performance modes (P2)

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| E1 | ✅ | `ExecutionMode`/`DecodeMode` types + defaults | §15.13 | `execution/plan.ts`; default `"safe"`/`"strict"`; composed into `planKey` (F2) |
| E2 | ✅ | Thread mode through `Database` + a layer wrapper | §15.13 | `DatabaseService.mode?`/`decodeMode?` (default safe); `withMode(layer, mode)` overrides without touching the query API or any layer constructor |
| E3 | ✅ | `trusted` mode: skip re-guarding prevalidated shapes | §15.13 | `guardForMode` skips the guard only when a prior success is recorded for the shape+profile+policy; decode stays strict |
| E4 | ✅ | `unsafe`/hot mode: skips decode, opt-in only | §15.13/15.17 | `unsafe` → `resolveDecodeMode` returns `trusted` → raw rows returned undecoded; only reachable via `withMode(..., "unsafe")`, never a default |
| E5 | ✅ | Capability checks never bypassed without a recorded pass | §15.17 | Verified: `unsafe` insert…returning on MySQL still fails with `CapabilityError` before the driver (no prior guard recorded) |

**Definition of done:** the public query API shape is unchanged across modes; unsafe requires opt-in; capability safety preserved. ✅ (5 tests in `execution-modes.test.ts`; perf measured in Epic I once bench lanes add a mode axis)

---

## Epic F — Cache-key composition & optimization strategies (P1)

> §15.14: the compiled cache key should include dialect id, dialect version/capability profile, query structural hash, execution mode, and decode mode — and **must not** include parameter values.

| # | Status | Task | Spec | Effort | Acceptance |
|---|---|---|---|---|---|
| F1 | ✅ | Add a stable **capability-profile hash** per dialect | §15.14 | S | Every dialect exposes a versioned `profileHash` derived from its syntax version and capability matrix |
| F2 | ✅ | Recompose cache and plan keys | §15.14 | S | Compiled key is `dialectId : profileHash : structuralHash`; execution plan appends `mode : decodeMode`; both are value-independent |
| F3 | ✅ | Audit/complete required optimization strategies | §15.14 | M | Bitsets, nested guard memo, decoder reuse, shape/value split, bounded identifier/alias interning, metadata reuse, and shallow builder path-copying are implemented and documented |
| F4 | ✅ | Structural hash from IR rather than SQL text | §15.14, §14.12 | M | Normalized dialect-independent IR material is hashed once per query identity and reused by every dialect compiler; focused invariants landed, with generative expansion tracked by H3 |

**Definition of done:** cache keys satisfy §15.14 composition and the §15.17 "never cache param values" rule.

---

## Epic G — SQL feature matrix tests (P1)

> §14.11: a growing, executable matrix (`defineSqlFeatureSuite`) run at unit, fake-execution, and real-integration levels, capability-aware, Levels 1–10.

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| G1 | ✅ | `defineSqlFeatureSuite` + `runSqlFeatureMatrix` | §14.11 | `testing/sql-features.ts`: feature type (id/level/requires/build/assertSql/exec/assertResult) + capability-aware runner |
| G2 | ✅ | Unit level: SQL snapshot + required capabilities per feature | §14.11 | Per-dialect `assertSql` snapshot (pg/sqlite/mysql) + `requiredCapabilities()` asserted |
| G3 | ✅ | Fake-execution level: params/cardinality/decode/typed-errors | §14.11 | Each feature runs against `FakeDriver`; unsupported capability → `CapabilityError` before the driver (driver untouched) |
| G4 | ✅ | Integration level: run suites via Effect Layers | §14.11 | `runSqlFeatureIntegration` executes each feature against a live layer in `unsafe` mode (validity, not decode) — supported ⇒ no `DriverError`, unsupported ⇒ `CapabilityError`. SQLite in the default run (`sql-features.integration.test.ts`, 12/12); Postgres + MySQL wired in `sql-features.integration.e2e.test.ts` — verified green (`pnpm e2e`), MySQL returning ⇒ `CapabilityError` |
| G5 | ✅ | Populate Levels 1–2 (DML + typed semantics) | §14.11 | `LEVEL_1_2_FEATURES`: 12 features (projection/where/and-or/order-limit/insert/update/delete/nullable/maybeOne + insert·update·delete returning) across 3 dialects → 96 generated cases |
| G6a | 🟡 not started | Levels 6, 8, 10 (data types, transactions, DDL) — buildable with today's IR | §14.11 | Same `defineSqlFeatureSuite` shape; add a data-type/transaction/DDL feature array — no new query IR needed. No such array exists yet (only `LEVEL_1_2_FEATURES`, `ADVANCED_SQL_FEATURES`, `ROUTINE_SQL_FEATURES`). Level 7 (upsert) is **already done** under G6b |
| G6b | ✅ | Levels 3–5, 7, 9 (joins, aggregation, CTE, window, upsert, routines) | §14.11 | `ADVANCED_SQL_FEATURES` (13 features) covers Levels 3–5 plus the Level 7 upserts (`insert.onConflict`, `insert.onDuplicateKey`); `ROUTINE_SQL_FEATURES` (5 features) covers scalar/aggregate/window/table/procedure behavior, capability failures, and decoding at Level 9 |

**Definition of done:** G6b is complete with executable, capability-aware
definitions for Levels 3–5, 7, and 9. G6a separately tracks the unstarted
Levels 6, 8, and 10 (data types, transactions, DDL). 🟡

---

## Epic H — Property & fuzz tests (P2)

| # | Status | Task | Spec | Effort | Acceptance |
|---|---|---|---|---|---|
| H1 | ✅ | Add a property-testing dep (respect `minimumReleaseAge`) | §14.12 | S | Mature `fast-check` 4.8.0 is pinned; pnpm enforces a strict seven-day `minimumReleaseAge`; `test:property` runs the focused Vitest suite |
| H2 | ✅ | IR/compiler invariants | §14.12 | M | Generated queries prove `normalize(normalize(ir)) === normalize(ir)`, placeholder completeness, and deterministic encounter-order parameters across pg/sqlite/mysql |
| H3 | ✅ | Cache-key invariants | §14.12, §16 | S | Generated bound-value rewrites retain hashes/SQL/keys; changed limits produce different structural and compiled keys |
| H4 | ✅ | Capability/optimization invariants | §14.12, §15.17 | S | MySQL `RETURNING` fails before `FakeDriver` in all modes; normalization retains capability bits and volatile-call order |
| H5a | ✅ | Fuzz **current** features (predicate trees, ordering, pagination, mutations) | §14.12 | M | Generators over today's IR feed H2–H4 |
| H5b | ✅ | Join/subquery generation | §14.12 | M | Aliased join variants and correlated subqueries feed normalization, parameter-order, cache-key, and capability properties |

**Definition of done:** H1–H5 are property-tested with deterministic replay. ✅

---

## Epic I — Performance benchmarks, targets & CI gates (P1)

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| I1 | ✅ | Fake/no-op driver hot-path benchmark | §15.12 | `bench:overhead` + `bench:hotpath` measure Thor overhead over a constant driver |
| I2 | ✅ | Cache-hit vs cold-compile benchmark | §15.16 | `bench:hotpath` measures `point.cold` (rebuild each call) vs `point.warm` (memoized IR) → **~10× faster** cache hit (≈9.7× in the recorded baseline) |
| I3 | ✅ | Prepared-handle benchmark | M7 | `point.warm` vs `point.prepared` → **~1.5–1.6× faster**; `point.prepared` lands at **~2.06 µs**, essentially at the 1–2 µs target |
| I4 | ✅ | Node **and** Bun benchmark lanes | M7 | `bench:hotpath` + `bench:hotpath:bun` (also `:overhead`/`:sqlite`); the no-op driver needs no runtime-specific client |
| I5 | ✅ | 1–2 µs hot-path overhead **tracking** | §15.12/18.8 | The script prints `point.prepared ≤ 2 µs — MET/over` each run; recorded in `driver-benchmarks.md` |
| I6 | ✅ | CI performance **gates** (staged) | §15.16 | `bench:baseline` records `hotpath-baseline.json`; `bench:gate` fails on a **>2.5× catastrophic regression**, auto-records the first baseline, and runs in the Node CI job |
| I7 | ✅ | Per-feature benchmark requirement | §18.9 | Checklist in `driver-benchmarks.md` (“Performance contribution checklist”): new query features add build/IR/compile/cap-check/exec benchmarks + a `bench:gate` run |

**Definition of done:** hot-path overhead is measured per runtime, cache-hit ≫
cold, unsupported caps fail before the driver, and CI runs the catastrophic
regression gate. ✅

---

## Epic J — Advanced query features (unblocks G6b + H5b)

> **Deadlock resolution.** G6 ("populate Levels 3–10") and H5 ("advanced-SQL
> fuzzing") were mutually stuck: G6 could not finish because Levels 3–5 need
> joins/aggregation/CTE/window, and H5 was written as "awaits G6". Neither is the
> real blocker — **both depend on query-builder features that no epic owned**.
> Making that prerequisite explicit (Epic J) breaks the cycle: J → {G6b, H5b},
> while **G6a and H5a proceed now** with today's IR. Joins etc. are a v0
> *non-goal expansion* (spec §3.2 defers the relation layer), so J is scheduled
> after the P1/P2 backbone, and G6b/H5b are explicitly gated on it — not on each
> other.

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| J1 | ✅ | Join IR + compiler (`inner/left/right/full`, aliases, join scope guard) | §6, §8.1, §14.11 L3 | Immutable join terms, `alias()`, incremental join-scope guards, all join builders, per-dialect capabilities, and matrix coverage |
| J2 | ✅ | Subqueries (`from`/`where`/`exists`/`in`) | §14.11 L3 | Derived/scalar/exists/in nodes compile recursively; ordinary derived tables reject correlation while expression/lateral subqueries receive outer scope |
| J3 | ✅ | Aggregation (`count/sum/avg/min/max`, `group by`, `having`, `distinct`) | §14.11 L4 | Typed aggregate/windowable expressions, grouping clauses, and `aggregation-scope` guard with matrix and focused tests |
| J4 | ✅ | Advanced selection (CTE, recursive CTE, window fns, lateral, set ops) | §14.11 L5, §9 caps | Named/recursive CTEs, window specs, lateral joins, and union/intersect/except are capability-gated and structurally hashed |
| J5 | ✅ | Upsert / `on conflict` / `on duplicate key` | §14.11 L7, §9 caps | PostgreSQL/SQLite conflict SQL and MySQL duplicate-key SQL use separate capability bits and reject unsupported dialects before the driver |

**Definition of done:** each advanced feature has IR + per-dialect compiler +
capability gating, and lands **as `defineSqlFeatureSuite` entries** — which is
exactly what unblocks **G6b** (Levels 3–5, 9) and **H5b** (join/subquery fuzzing).
✅ J1–J5 are implemented and G6b's Level 9 routine expansion is complete.

---

## Cross-cutting acceptance (invariants)

- **§18.6 Integration testing:** all dialects via Layers, capability-aware suite, explicit isolation → Epics B, G.
- **§18.7 Runtime portability:** dialect ≠ runtime; adapters share the `Database` contract; valid only when passing the suite under that runtime → Epics C, B.
- **§18.8 Hot-path performance:** measurable, memoized, precompilable, 1–2 µs target → Epics D, F, I.
- **§18.9 Benchmark:** every new query feature ships benchmarks → Epic I7.

## Suggested first cut

1. **Phase 0 (A1–A5)** — a few small doc edits; removes all doc drift today.
2. **F1–F2 + D1–D5** — cache key + `.prepare()` handles; the biggest functional gap and the backbone of the perf story.
3. **B1–B3** — make SQLite/MySQL spec-valid by passing the shared suite.

---
---

# Part II — v1 milestone

Source of truth: [`thor-project-v1-spec.md`](./thor-project-v1-spec.md) (the
production-readiness release). v1 keeps the v0 foundation (typed/runtime IR,
guards, capabilities, Effect execution, tests, benchmarks — Epics A–J) and adds
mature dialects, a compiled-query API, explicit relations, production migrations,
introspection, Node+Bun runtimes, safe routines, observability, LLM skills, and
benchmarked hot paths.

**New epics use letters K onward.** Several build directly on v0 work (noted
under "builds on"); **Epic J (joins/aggregation) is a hard prerequisite** for the
relation layer's `join` strategy and the feature matrix's advanced levels.

## v1 epic overview

| Epic | Theme | v1 spec | Milestone | Builds on | Status |
|---|---|---|---|---|---|
| K | Compiled Query API (`.compile()` → executable handle) | §8 | alpha.1 | D (`.prepare`) | ❌ |
| L | Query caches + precompilation modes | §9, §10 | alpha.1 | F, D, E | ❌ |
| M | Dialect hardening v1 (full contract, MySQL/Postgres) | §11 | alpha.2 | B | 🟡 (v0 suites pass) |
| N | Runtime lanes v1 (Node + Bun) | §12 | alpha.3 | C | 🟡 (caps + Bun harness) |
| O | Migration hardening v1 (dry-run, expand/contract, policies) | §15 | alpha.4 | migrator (§13 v0) | 🟡 |
| P | Introspection & drift detection | §16 | alpha.4 | migrator `drift()` | ❌ |
| Q | Relation layer (`defineRelations`, strategies, no N+1) | §13 | alpha.5 | **J**, FK metadata | ❌ |
| R | Routines v1 (functions/procedures, typed + guarded) | §14 | beta | routine module (wired in v0) | 🟡 |
| S | Observability (metadata, spans, param-redaction) | §17 | beta | annotations (§7.4 v0) | ❌ |
| T | CLI v1 (`doctor`/`capabilities`/`bench`/`skills`/`inspect`) | §20 | beta | CLI (v0) | ❌ |
| U | LLM skills (11 skill files + manifest + export) | §21 | beta | — | ❌ |
| V | API stability levels + error model v1 | §6, §22 | beta | errors (v0) | ❌ |
| W | Benchmarks v1 + docs v1 (cold/warm/hot, Node+Bun) | §19, §23 | beta | I | 🟡 |

## v1 milestone → epic map

```
v1-alpha.1  Compiled query + cache foundation   → K, L, (W hot-path baselines)
v1-alpha.2  Dialect contract expansion          → M
v1-alpha.3  Runtime lanes                        → N
v1-alpha.4  Migration hardening + introspection  → O, P
v1-alpha.5  Relation layer                        → Q   (⟵ J)
v1-beta     Observability, skills, API stability → R, S, T, U, V, W
```

---

## Epic K — Compiled Query API (§8, alpha.1)

> v0 memoizes internally (Epic D handles); v1 exposes a **stable, public**
> compiled-query value that bypasses fluent rebuild / normalization / guard
> traversal / recompilation / decoder reconstruction on the hot path.

| # | Task | Spec | Acceptance |
|---|---|---|---|
| K1 | `.compile()` on terminal queries → `CompiledQuery` value | §8.2 | `query.one().compile()` returns a handle with `.execute(params)` |
| K2 | `CompiledQuery<Params, Output, Error, Requirements, Dialect, Cardinality>` type | §8.3 | exposes `cacheKey`, `dialect`, `cardinality`, `capabilities: ReadonlySet<Capability>` |
| K3 | `.execute(params)` binds values separately; never bakes values | §8.4 | compiled-query invariant: params supplied at execute time; cache key/SQL value-independent (reuse Epic D `PreparedExecutionPlan`) |
| K4 | Cheap per-execute validation only (capability/version, param-by-mode) | §8.1 | warm path skips guard traversal; still does capability/version check + prepared lookup + decode-by-mode |
| K5 | Docs + `@stable` marking (part of §6) | §6.1 | compiled query API listed stable and documented |

## Epic L — Query caches + precompilation modes (§9, §10, alpha.1)

> Formalize the ad-hoc WeakMaps (Epics F/D) into named, bounded cache layers.

| # | Task | Spec | Acceptance |
|---|---|---|---|
| L1 | Name the 5 cache layers: shape, compile, prepared, decoder, capability | §9.1 | each keyed by **shape, not values** (§9.2); documented |
| L2 | `db.withQueryCache({ maxSize, strategy: "lru" })` | §9.3 | bounded caches with eviction; default sizes |
| L3 | `query.compile({ cache, prepare })` options | §9.3 | opt in/out of cache + prepared per compile |
| L4 | `compile()` / `compilePrepared()` / `compileUnsafeHot()` | §9.4 | prepared when driver supports; `compileUnsafeHot` requires explicit unsafe opt-in on pre-validated paths |
| L5 | `db.withMode("safe"\|"trusted"\|"unsafe-hot")` sugar over Epic E | §10 | rename `unsafe`→`unsafe-hot`; `withMode` on `db`, not only the layer |
| L6 | Cache-layer benchmarks + hit/miss counters | §9, §19 | cold/warm/prepared measured per layer; feeds observability (S) |

## Epic M — Dialect hardening v1 (§11, alpha.2)

| # | Task | Spec | Acceptance |
|---|---|---|---|
| M1 | Postgres passes the **full** contract + feature matrix | §11.4, alpha.2 | no gaps vs Level 1–2 (and Level 3+ as J lands) |
| M2 | MySQL capability-aware pass or **explicitly marked partial** | §25 | matrix records unsupported (`RETURNING`, …) and asserts `CapabilityError` |
| M3 | SQLite real adapter path hardened (Node + Bun) | alpha.2 | contract suite green on both runtimes |
| M4 | Dialect-specific behavior isolated (no leakage into IR/guards) | §11.5 | audit: shared core stays dialect-neutral |
| M5 | `thor capabilities <dialect>` reflects the matrix | §20.3 | native/emulated/unsupported/unknown per capability |

## Epic N — Runtime lanes v1 (§12, alpha.3)

> Builds on C (runtime capabilities modeled; Bun contract harness ready — C3).

| # | Task | Spec | Acceptance |
|---|---|---|---|
| N1 | Formal **Node lane** + **Bun lane** in CI | §12, §18 | both lanes run the shared suites; Bun for supported adapters |
| N2 | Runtime capability matrix drives adapter selection | §12.1 | `runtime.sqlite.bun` etc. gate driver availability |
| N3 | Bun-specific SQLite driver path sharing the SQLite dialect | §12.3 | `bun:sqlite` adapter passes the same suite/fixture |
| N4 | Runtime benchmarks (Node vs Bun) recorded | §12, §19 | `bench:*:bun` lanes formalized; results in `driver-benchmarks.md` |
| N5 | Runtime testing invariant enforced | §12.4 | "valid only when the adapter passes the suite under that runtime" |

## Epic O — Migration hardening v1 (§15, alpha.4)

> Builds on the v0 live migrator (up/down/generate/apply/check/drift ✅).

| # | Task | Spec | Acceptance |
|---|---|---|---|
| O1 | `Migrator.dryRun()` + `Migrator.plan(schema)` | §15.3 | plan/dry-run without applying; reviewable |
| O2 | Expand/contract generator (`--strategy expand-contract`) | §15.5 | emits add → backfill → require → drop steps; destructive steps blocked unless reviewed |
| O3 | Migration policies incl. `expand-only`, `allow-reviewed-destructive` | §15.4 | production default blocks destructive auto-migration |
| O4 | Seed/backfill helpers | §15.1 | typed data backfill steps through Effect |
| O5 | Transactional-DDL capability awareness | §15.1 | wrap in tx where supported (PG), not where not (MySQL) |
| O6 | Generated-migration tests + routine/function DDL support | §15.1 | generated SQL snapshot tests; create/drop function/procedure ops |

## Epic P — Introspection & drift detection (§16, alpha.4)

| # | Task | Spec | Acceptance |
|---|---|---|---|
| P1 | `Introspector` service: `currentSchema()` | §16.3 | reads live DB → Schema IR (tables/columns/indexes/constraints/FKs/enums/views/routines) |
| P2 | `Introspector.drift(expectedSchema)` | §16.3, §16.5 | diffs live vs schema-as-code; reports before `up` unless policy ignores |
| P3 | Per-dialect introspection queries (pg/sqlite/mysql) | §16.4 | `information_schema`/`pragma`/`SHOW` per dialect |
| P4 | CLI `thor pull` / `introspect` / `inspect schema` / `inspect routines` | §16.2 | writes/prints introspected Schema IR |
| P5 | Wire `drift` into `thor doctor` + migration flow | §16.5, §20.2 | drift surfaced pre-migration |

## Epic Q — Relation layer (§13, alpha.5) — ⟵ Epic J

> Sits **on top of** the IR (never bypasses it): relation query → planner → IR →
> guards → caps → compiler → executor. Needs join support (J) + FK metadata.

| # | Task | Spec | Acceptance |
|---|---|---|---|
| Q1 | `column.references(() => other)` foreign-key metadata | §13.2 | FK captured in schema IR (also feeds P) |
| Q2 | `defineRelations({...})` with `one()` / `many()` | §13.2 | typed relation graph keyed by table |
| Q3 | `db.relation(t).findMany({ with: { rel: { strategy } } })` | §13.2 | relation planner lowers to Query IR |
| Q4 | Loading strategies: `join` (⟵ J), `query` (batched by keys), `manual` | §13.3 | explicit per relation; no default magic |
| Q5 | **No hidden N+1** guard | §13.4 | a would-be N+1 is rejected, batched, or requires explicit opt-in |
| Q6 | Relation planner tests + `@experimental` marking | §6.2, alpha.5 | planner unit tests; API marked experimental |

## Epic R — Routines v1 (§14, beta)

> Builds on the `routine/` module, whose descriptors **and** expression/`from`/execution
> wiring already landed in v0 (Level 9 matrix, G6b). Implemented and tested in
> `routine-query.test.ts`: scalar calls in expressions (R1), table-valued functions
> in `from` (R4), procedure `.run()` execution (R3 core), and capability + return-decode
> safety (R5). Remaining v1 work: advanced named/out arguments, full procedure
> effect/idempotency/tx-metadata honoring, and routine DDL in migrations (R6, ties to O6).

| # | Task | Spec | Acceptance |
|---|---|---|---|
| R1 | Scalar function calls usable in expressions | §14.1, §12.1(v0) | `pg.fn.lower(col)` / user `defineFunction` in select/where; lowers to `FunctionCall` IR |
| R2 | Aggregate + window function nodes (⟵ J aggregation) | §14.2 | group/window guards; capability-gated |
| R3 | Procedure execution through Effect | §14.5 | `db.procedure(p).call(args)` → typed Effect; effects/idempotency/tx metadata honored |
| R4 | Table-valued functions in `from` | §14.2 | `defineTableFunction` usable as a source |
| R5 | Routine safety + capability gating | §14.6 | names never interpolated; required extensions/capabilities enforced |
| R6 | Routine DDL in migrations (create/drop function/procedure) | §15.1 | ties to O6 |

## Epic S — Observability (§17, beta)

| # | Task | Spec | Acceptance |
|---|---|---|---|
| S1 | Structured per-query metadata | §17.1 | kind/dialect/runtime/tables/hash/compile+prepared cache hit-miss/duration/rowCount/errorTag/txn id |
| S2 | Effect tracing spans with `thor.*` names | §17.2 | `thor.query.select.users`, `thor.transaction.commit`, `thor.migration.apply` |
| S3 | Parameter-logging modes `none` / `redacted` / `unsafe-full` | §17.3 | default never logs raw params; `unsafe-full` explicit |
| S4 | `db.withObservability({ tracing, metrics, logSql, logParams })` | §17.4 | opt-in tracing/metrics/log levels |
| S5 | Observability invariant test | §17.5 | no sensitive data leaks by default (asserted) |

## Epic T — CLI v1 (§20, beta)

> Wires the v0 CLI stubs (`up`/`down`/`generate`/`drift`/`pull`) to the live migrator + adds new commands.

| # | Task | Spec | Acceptance |
|---|---|---|---|
| T1 | Wire DB-connected commands to the live migrator/introspector | §20.1 | `up`/`down`/`generate`/`drift`/`pull`/`inspect` run against a configured DB |
| T2 | `thor doctor` | §20.2 | checks runtime/dialect/driver/connectivity/journal/pending/drift/capabilities/config |
| T3 | `thor capabilities <dialect\|runtime>` | §20.3 | prints native/emulated/unsupported/unknown |
| T4 | `thor bench <query\|compile\|decode\|runtime>` | §20.4 | runs the bench groups; `--node`/`--bun` |
| T5 | `thor skills list\|export` | §20.5, §21 | exports skill files to an agent workspace (`--to`, `--format md\|json`) |

## Epic U — LLM skills (§21, beta)

| # | Task | Spec | Acceptance |
|---|---|---|---|
| U1 | Skill file format (goal/use-when/checks/safe+unsafe patterns/examples/verification) | §21.3 | one canonical shape |
| U2 | Author the 11 required skills | §21.4 | `schema`, `query`, `effect-execution`, `migrations`, `capabilities`, `routines`, `testing`, `benchmarks`, `dialects`, `debugging`, `safety` |
| U3 | Skill manifest | §21.5 | machine-readable index of skills |
| U4 | `thor skills export` (md + json, `--to`) | §20.5, §21 | writes skills into `./.agents/skills/thor` |
| U5 | LLM usage invariant | §21.6 | skills encode capability-checking + no-raw-interpolation safety rules |

## Epic V — API stability + error model v1 (§6, §22, beta)

| # | Task | Spec | Acceptance |
|---|---|---|---|
| V1 | Tag APIs `@stable` / `@experimental` / `@internal` | §6 | stable: schema DSL, builder, exec methods, compiled query, migration format, tagged errors, capability names, dialect interface, testing helpers, CLI migration cmds |
| V2 | Document the boundaries | §6, §23 | stability doc; `inspect()` stable-for-debug only |
| V3 | Freeze + document the public tagged error set | §22 | every public error tag listed with fields + `catchTag` guidance |
| V4 | Error model completeness pass | §22 | no generic exceptions where a tagged error should exist |

## Epic W — Benchmarks v1 + docs v1 (§19, §23, beta)

> Extends Epic I with the v1 benchmark groups + baselines under both runtimes.

| # | Task | Spec | Acceptance |
|---|---|---|---|
| W1 | Benchmark groups: build/IR/compile/decode/effect/cache/runtime | §19.1 | each stage measured separately |
| W2 | Cold / warm / hot baselines under **Node and Bun** | §19.5, §25 | recorded baselines; gate per runtime |
| W3 | Hot-path targets tracked (warm cached path) | §19.3 | overhead vs target reported (extends I5) |
| W4 | Benchmark gates stabilized | §19.6, beta | tighten `bench:gate` threshold once baselines settle |
| W5 | v1 docs pass | §23 | README + subpath docs cover compiled queries, relations, introspection, observability, skills, stability |

---

## v1 cross-cutting invariants

- **Compiled query (§8.4):** validated shape, never values — cache keys/SQL value-independent → K.
- **Relation (§13.4):** no hidden N+1; reject/batch/opt-in → Q.
- **Drift (§16.5):** live-vs-code drift reported before migrating unless policy ignores → O, P.
- **Observability (§17.5):** visible behavior, no param leakage by default → S.
- **Routine safety (§14.6):** declared/typed/capability-aware; names never interpolated → R.
- **Runtime (§12.4):** valid only when the adapter passes the suite under that runtime → N.

## v1 suggested first cut

1. **K + L** (alpha.1) — public `.compile()` + named caches; the hot-path API v1 is built around (backbone; reuses D/F/E).
2. **J** (v0 tail) — joins/aggregation; unblocks **Q** (relation `join` strategy) and the feature-matrix advanced levels.
3. **P + O** (alpha.4) — introspection/drift + migration hardening; the production-migration story.
