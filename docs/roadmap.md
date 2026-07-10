# Thor roadmap

Sources of truth: [`thor-project-spec-v0.md`](./thor-project-spec-v0.md) for the
delivered v0 foundation and [`thor-project-v1-spec.md`](./thor-project-v1-spec.md)
for Part II. This roadmap also tracks production-correctness work found by the
independent repository review.

**Status legend:** ✅ done · 🟡 partial · ❌ missing
**Priority:** P0 (blocking correctness/spec-validity) · P1 (release hardening) · P2 (maintainability/beta quality)
**Effort:** S (<½ day) · M (½–2 days) · L (>2 days)

> **Current priority (2026-07): Part 0 below.** An independent repository review
> ([`thor-repository-review.md`](./thor-repository-review.md), commit `fe92138`)
> found production-correctness gaps behind the v0 surface. **Part 0 (P0) now takes
> priority over the remaining Part II (v1) expansion** and is sequenced first.
> Part I's main v0 foundation is delivered, with residual work explicitly marked;
> Part II is deferred until the P0 correctness work lands, and publication is
> additionally gated by the P1 release-hardening work below. P0/P1/P2 ids match
> the review's numbering. Verified findings carry `file:line` evidence.

---

# Part 0 — Production-correctness and release hardening (current priority)

> Turn the v0 promises into enforced invariants before widening the surface.
> Each item was confirmed against the working tree at the cited lines. MySQL stays
> **explicitly partial** until non-transactional migration behavior, numeric
> decoding, and its full live suite are hardened.

### PR 1 — Correct the trust boundary (query core)

| # | Status | Task | Evidence | Effort | Acceptance |
|---|---|---|---|---|---|
| P0-3 | ✅ | Typed & validated named parameters | `ParameterPlan` compiles schema encoders once; builder terminals carry literal-name maps; `parameters.types.ts` covers negative cases | L | Param map threaded through builder generics so `param("id", Schema.String)` requires `{ id: string }`; compile the validator once per plan and validate/encode values once per execution; missing/extra/mistyped/duplicate/conflicting names → tagged `ParameterError` (not `undefined` to the driver); compile-time negative tests |
| P0-4a | ✅ | Dialect/driver-aware decoding (bigint, numeric aggregates, date, bool, json) | driver-representation codecs accept safe numeric strings/bigints; advanced live matrix runs on PostgreSQL/MySQL in safe mode | M | pg `count/sum/avg`/bigint decode correctly in **safe** mode; counts are safe `number` and reject overflow; per-driver representations are normalized by codecs |
| P0-4b | ✅ | Join nullability in type state + decoder plan | outer joins rewrite both row type and selection codecs (columns **and** non-column expressions on the null-extended side); compile-time + runtime tests cover left/right/full | L | left/right/full-join columns become nullable in TS **and** use a nullable codec; runtime + type tests |
| P0-4c | ✅ | Run the feature-integration matrix in **safe** decode mode | SQLite and live PostgreSQL/MySQL feature matrices use the default safe layer | S | representative outputs decoded in safe mode; aggregate decoder defects fail the suite |

### PR 2 — Make migrations honest and safe

| # | Status | Task | Evidence | Effort | Acceptance |
|---|---|---|---|---|---|
| P0-1a | ✅ | Acquire the lock **before** reading pending; re-read under lock | advisory-lock dialects plan under the lock; SQLite re-reads inside each `begin immediate` transaction | M | journal-create/read/checksum/pending all move inside the lock; two racing migrators cannot double-apply the same migration |
| P0-1b | ✅ | Propagate commit/rollback failures | transaction and lock finalizers replay/compose `Exit` causes instead of ignoring them | S | failed commit surfaces; body+rollback and body+unlock failures retain both causes |
| P0-1c | ✅ | Choose & document one transaction policy | one transaction per migration on transactional-DDL dialects; MySQL partial progress is documented and tested | M | per-migration transactions; README no longer claims unconditional transactionality |
| P0-1d | ✅ | `check()` rejects unknown / out-of-order journal entries | journal validation requires an exact known definition prefix before checksum validation | S | unknown applied entries, gaps/order drift, and checksum drift fail |
| P0-1e | ✅ | Explicit checksum/revision for Effect migration steps | Effect steps require `revision`; checksum material includes it | S | changing a backfill revision changes its checksum; omission fails compile-time testing |
| P0-1f | ✅ | Concurrency & failure migration tests | `migrator.test.ts` covers races, commit/rollback, lock loss, unknown state, non-transactional partial progress, interruption | M | required concurrency and failure paths are executable tests |
| P0-2 | ✅ | Lossless schema → migration DDL IR | typed defaults, generated columns, unique/check/FK constraints and indexes survive schema→IR→all dialect compilers; SQLite live introspection test; SQLite `ADD COLUMN` rejects in-place-illegal shapes (unique, stored-generated, non-constant/absent default) as tagged failures | L | non-round-trippable defaults are rejected; unsupported dialect alterations become tagged migration failures |

### PR 3 — Ship what users actually install

| # | Status | Task | Evidence | Effort | Acceptance |
|---|---|---|---|---|---|
| P0-5 | ✅ | Stop advertising placeholder CLI commands as working | published help/dispatcher expose only `init`/`create`; every other command exits non-zero; names are path-safe; subprocess tests | M | truthful minimal CLI surface with validated migration names |
| P0-6 | ✅ | Repair the performance regression gate | reviewed `hotpath-baselines/<runtime>-<platform>-<arch>.json`; missing/invalid baselines fail; docs label the threshold catastrophic-only | S | clean CI compares against a committed reviewed baseline and never self-baselines |

### Release gate — Harden the public package and Effect integration (P1)

| # | Status | Task | Evidence | Effort | Acceptance |
|---|---|---|---|---|---|
| P1-7a | ✅ | Scoped, resource-safe client layers | `PostgresScopedLayer`/`PostgresPoolLayer`, `MySQLScopedLayer`/`MySQLPoolLayer`, and `SQLiteScopedLayer`; `scoped-layers.test.ts` covers cleanup and failure causes | L | retain low-level bring-your-own-client constructors; add documented `Layer.scoped` paths that acquire/connect and release/end; acquire dedicated pooled connections where affinity is required; test acquisition/release failure, interruption, cancellation where supported, and pool exhaustion |
| P1-7b | ✅ | Transaction-scoped driver/database API | `execution/transaction.ts` backs `db.transaction` and the migrator; `transaction.test.ts` covers savepoints, isolation, retry boundaries, interruption, and combined causes | L | explicit scoped transaction driver used by `db.transaction` and the migrator; savepoints/isolation levels and retry boundaries; commit/rollback/release failures preserved; affinity tests across supported drivers (also unblocks a correct future libSQL adapter) |
| P1-8a | ✅ | Publication metadata and clean tarballs | package metadata/READMEs/LICENSE, SECURITY, CHANGELOG, `prepack`, peer-only published Effect policy, and `test-packages.mjs` Node+Bun consumers | M | ship LICENSE in each package, add SECURITY policy, changelog/release notes, package READMEs/metadata/engines, `files`, and build-before-pack; resolve the `effect` dependency policy; packed tarballs contain only intended artifacts; every export and the `thor` binary work from clean Node and Bun consumer projects |
| P1-8b | ✅ | Align and test the runtime support policy | root/packages/README declare Node ≥22; CI tests oldest supported Node 22 and current Node 26; declarations compile with `@types/node` 22 | M | either raise the baseline or test the oldest declared Node plus current; package engines and docs agree; type surface does not exceed the supported baseline |
| P1-9 | ✅ | Make CI enforce documented invariants | separate static, Node 22/26 coverage, packed Node, Bun, PostgreSQL/MySQL, and performance jobs; immutable action SHAs, deterministic fast-check seed, minimal permissions/concurrency | M | static, unit/property, safe integration, runtime, package/CLI, and performance lanes; deterministic seeds/failure replay; minimal permissions and concurrency cancellation; actions pinned to immutable SHAs |
| P1-10 | ✅ | Tighten raw SQL and migration trust boundaries | `RawExpr` retains structural params/columns; dialect compiler quotes/binds; `unsafeSql` is required for dynamic text in queries and migrations; dialect/type/injection tests | M | parameters and identifiers remain structural nodes quoted by the active dialect; ordinary value interpolation rejected; arbitrary text requires an explicit `unsafeSql` brand; the same explicit unsafe boundary applies to migrations; cross-dialect and injection tests |

### Maintenance follow-up (P2)

| # | Status | Task | Evidence | Effort | Acceptance |
|---|---|---|---|---|---|
| P2-11 | 🟡 | Split oversized modules and add code-quality tooling | IR traversal moved to `query-analysis.ts` (reducing `query-ir.ts` to declarations); Biome incrementally gates new seams, Knip gates the workspace, and dead placeholder exports/files were removed; query-builder/features/execution splits remain | L | split along existing statement/execution/feature seams without public API churn; add formatter/linter plus dead-export/dependency checks and enforce them in CI |
| P2-12 | 🟡 | Make documentation executable and claims generated | README lifecycle/CLI/runtime claims corrected; all TS fences syntax-check, a canonical query executes, and the dialect summary is generated from capability matrices; spec archival remains | M | examples are tested or executable; feature/status tables derive from capability/schema metadata; one current spec plus clearly archived versions; README claims match live behavior |
| P2-13 | ✅ | Enforce the narrowed milestone scope | release-work registry below names prerequisites/owner/tests/claim; Part II remains deferred; MariaDB/libSQL are explicitly unscheduled candidates | S | no new v1 surface begins before P0 is green; each resumed epic names prerequisites, owner, tests, and a release claim it closes; MariaDB/libSQL remain unscheduled candidates until dialect and transaction foundations are hardened |

### Release-work registry

| Work | Prerequisites | Owner | Required tests | Release claim closed |
|---|---|---|---|---|
| P1-7 lifecycle + transactions | P0 migration failure invariants | Thor maintainers | `transaction.test.ts`, `scoped-layers.test.ts`, migrator unit/e2e suites | Effect resources and transaction affinity are production-safe |
| P1-8/P1-9 package + CI | P1-7 public lifecycle shape | Thor maintainers | Node/Bun packed consumers, Node 22/26 coverage, dialect e2e, performance gate | Published artifacts match the documented runtime and command surface |
| P1-10 trust boundary | P0 typed parameter plan | Thor maintainers | dialect raw-SQL tests, migration trust tests, compile-time negatives | Ordinary input cannot silently become SQL syntax |
| P2-11 maintainability | P1 public API stabilized | Thor maintainers | Biome, Knip, build/type/docs/full tests after each seam split | Beta source is mechanically maintainable without public churn |
| P2-12 executable docs | P1 package/runtime policy | Thor maintainers | README example runner, generated capability check, package consumers | Beta documentation cannot drift from executable metadata |

No MariaDB or libSQL epic is scheduled. They may be reconsidered only after the
P2-11 seam splits and live affinity tests provide a stable adapter foundation.

**P0 definition of done:** typed/validated params and safe-mode decoding across
dialects; migrations correct under concurrency and failure with lossless DDL; the
CLI tells the truth about what it can do; and CI actually gates performance. Then
Part II implementation may resume.

**Public-release gate:** P0 plus P1-7–P1-10 are green, packed-consumer tests pass,
and README/package claims match the supported runtime, dialect, CLI, and migration
surface. P2-11/P2-12 must land before beta; P2-13 remains an ongoing planning
constraint.

---

## Part I — v0 drift epic overview (foundation delivered; residuals tracked)

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
| I | Performance benchmarks, targets & CI gates | §15.12, §15.16, §18.8/18.9, M7 | ✅ I1–I5,I7 · 🟡 I6 (gate self-baselines — see P0-6) | P1 |
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
| I6 | ✅ | CI performance **gates** (staged) | §15.16 | `bench:gate` requires a reviewed runtime/platform/architecture baseline, fails when it is absent/invalid, and guards catastrophic >2.5× regressions without self-baselining |
| I7 | ✅ | Per-feature benchmark requirement | §18.9 | Checklist in `driver-benchmarks.md` (“Performance contribution checklist”): new query features add build/IR/compile/cap-check/exec benchmarks + a `bench:gate` run |

**Definition of done:** hot-path overhead is measured per runtime, cache-hit ≫
cold, unsupported caps fail before the driver, and CI runs the catastrophic
regression gate against a reviewed, committed baseline. 🟡 I6 remains open via
P0-6.

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

## Historical v0 first cut

1. **Phase 0 (A1–A5)** — a few small doc edits; removes all doc drift today.
2. **F1–F2 + D1–D5** — cache key + `.prepare()` handles; the biggest functional gap and the backbone of the perf story.
3. **B1–B3** — make SQLite/MySQL spec-valid by passing the shared suite.

---

# Part II — v1 milestone

> **Resumed after Part 0 P0 and the P1 release gate landed.** Epics K and L (the
> alpha.1 compiled-query + cache foundation) are the first resumed v1 expansion.
> P2-11/P2-12 remain beta gates, so alpha work may proceed but no beta/public
> release may bypass those maintenance and documentation tasks.

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
| K | Compiled Query API (`.compile()` → executable handle) | §8 | alpha.1 | D (`.prepare`) | ✅ K1–K5 |
| L | Query caches + precompilation modes | §9, §10 | alpha.1 | F, D, E | ✅ L1–L6 |
| M | Dialect hardening v1 (full contract, MySQL/Postgres) | §11 | alpha.2 | B | ✅ M1–M5 |
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

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| K1 | ✅ | `.compile()` on terminal queries → `CompiledQuery` value | §8.2 | All/one/maybeOne/run terminals expose shape-only compilation; parameterized no-argument terminals are compile-only, while param-free terminals remain directly executable Effects |
| K2 | ✅ | `CompiledQuery<Params, Output, Error, Requirements, Dialect, Cardinality>` type | §8.3 | Public exports retain all six axes and expose `cacheKey`, `dialect`, `cardinality`, and `capabilities: ReadonlySet<Capability>`; `parameters.types.ts` covers inference and negatives |
| K3 | ✅ | `.execute(params)` binds values separately; never bakes values | §8.4 | `PreparedExecutionPlan` rejects inline values; `compiled-query.test.ts` proves different values reuse identical SQL/cache/prepared identity |
| K4 | ✅ | Cheap per-execute validation only (capability/version, param-by-mode) | §8.1 | Compilation snapshots/normalizes/guards/compiles/builds decoder once; execution checks the dialect profile and cached capability outcome, then binds, looks up prepared identity, drives, and decodes by mode |
| K5 | ✅ | Docs + `@stable` marking (part of §6) | §6.1 | `CompiledQuery` is marked `@stable`; `docs/compiled-queries.md`, root README, and package README document usage and invariants |

**Release-work record:** prerequisite Epic D ✅; owner Thor maintainers; required
tests `compiled-query.test.ts`, `parameters.types.ts`, full unit/type/docs/quality
checks; closes the alpha.1 claim that applications can hoist a stable executable
query shape without retaining user values. **Definition of done:** K1–K5 are
implemented and verified. ✅

## Epic L — Query caches + precompilation modes (§9, §10, alpha.1)

> Formalize the ad-hoc WeakMaps (Epics F/D) into named, bounded cache layers.

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| L1 | ✅ | Name the 5 cache layers: shape, compile, prepared, decoder, capability | §9.1 | `execution/cache.ts` names all five as `CacheLayer`s in a `QueryCaches` registry, each keyed by **shape, not values** (§9.2); `run.ts` routes the non-prepared path through them; documented in `docs/query-cache.md` |
| L2 | ✅ | `db.withQueryCache({ maxSize, strategy: "lru" })` | §9.3 | `withQueryCache(layer, { maxSize, strategy })` (and `db.withQueryCache`) installs a bounded `BoundedLruCache` per layer with LRU eviction; default (omit `maxSize`) stays unbounded/GC-friendly |
| L3 | ✅ | `query.compile({ cache, prepare })` options | §9.3 | `.compile(dialect?, { cache, prepare, mode })` opts prepared/cache-observation per compile without baking values |
| L4 | ✅ | `compile()` / `compilePrepared()` / `compileUnsafeHot()` | §9.4 | all three on every terminal; `compilePrepared` forces prepared reuse; `compileUnsafeHot` requires the explicit method (prepared + decode-skip) yet still enforces capability guards |
| L5 | ✅ | `db.withMode("safe"\|"trusted"\|"unsafe-hot")` sugar over Epic E | §10 | `unsafe`→`unsafe-hot` with a normalized deprecated alias; `withMode`/`withQueryCache` exposed on `db` as well as the layer wrapper |
| L6 | ✅ | Cache-layer benchmarks + hit/miss counters | §9, §19 | `bench:cache` measures cold/warm/prepared and prints per-layer hit/miss/eviction/size counters; `db.queryCache.stats()` exposes them for observability (S) |

**Release-work record:** prerequisites Epics F/D/E ✅; owner Thor maintainers;
required tests `query-cache.test.ts` plus full unit/type/docs/quality checks;
closes the alpha.1 claim that hot-path caches are named, bounded, observable, and
never keyed by parameter values. **Definition of done:** L1–L6 are implemented and
verified. ✅

## Epic M — Dialect hardening v1 (§11, alpha.2)

| # | Status | Task | Spec | Acceptance |
|---|---|---|---|---|
| M1 | ✅ | Postgres passes the **full** contract + feature matrix | §11.4, alpha.2 | Both PostgreSQL drivers pass the expanded shared contract; live matrix covers complete Levels 1–5 plus 7/9 implemented surfaces, including routine decoding/table functions; Levels 6/8/10 remain separately scoped to G6a |
| M2 | ✅ | MySQL capability-aware pass or **explicitly marked partial** | §25 | Exhaustive matrix records every status; live contract/matrix prove plain mutations, right/lateral joins, sets, transactions, and duplicate-key updates while unsupported `RETURNING`, full join, conflict syntax, table routines, and transactional DDL are documented and rejected |
| M3 | ✅ | SQLite real adapter path hardened (Node + Bun) | alpha.2 | Node and Bun run the same expanded 12-case real contract and 37-case feature fixture; unsupported features fail through capabilities on both runtimes |
| M4 | ✅ | Dialect-specific behavior isolated (no leakage into IR/guards) | §11.5 | Logical data type renamed `SqlDataType`; candidate-row, routine-argument, and transaction-start syntax moved behind dialect hooks; architecture tests forbid dialect imports/ID branching in shared IR, guards, compiler, and transaction execution |
| M5 | ✅ | `thor capabilities <dialect>` reflects the matrix | §20.3 | Published CLI prints all capabilities in registry order for postgres/sqlite/mysql with native/emulated/unsupported/unknown statuses; subprocess and packed-consumer tests prevent drift |

**Release-work record:** prerequisite Epic B ✅; owner Thor maintainers; required
tests expanded shared contract, `sql-features.test.ts`, Node/Bun SQLite,
PostgreSQL/MySQL E2E, CLI subprocess/packed consumers, type/docs/quality checks;
closes the alpha.2 claim that shipped dialect targets are executable,
capability-aware, and truthfully reported. **Definition of done:** M1–M5 are
implemented and verified. ✅

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
