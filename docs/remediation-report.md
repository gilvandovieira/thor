# Thor remediation — consolidated verification report

Scope: the full independent-review remediation pass (Priority 0 → Priority 4)
verified against the `remediation/p0-correctness` branch. This report supersedes
nothing in [remediation-p0-report.md](./remediation-p0-report.md) or
[remediation-p1-report.md](./remediation-p1-report.md) — it adds the review-fix
findings, the Priority 3–4 work, and a single final validation.

Each finding is recorded as **Confirmed**, **Already fixed**, **Partially
valid**, **Disproved**, or **Reframed**, with the correction and its test.

## Priority 0 — release-blocking correctness

| # | Finding | Verdict | Correction & tests |
|---|---|---|---|
| P0.1 | Multi-row insert key-order | **Confirmed, fixed** | `canonicalizeInsertRows` projects every row into one canonical column list by key; unknown/missing/extra keys and empty inserts throw `ParameterError` at construction. `insert-canonicalization.test.ts` (+ property), `guards.test.ts`. |
| P0.2 | Inconsistent parameter encoding | **Confirmed, fixed (+ critical follow-up)** | `ParameterPlan` encodes inline values through the column codec exactly like named params. **Adversarial review found a residual injection hole**: object values structurally imitating a node (`{node:…}`, `{_tag:"Param"}`) bypassed the codec. Fixed with a non-forgeable `SqlInputBrand` symbol on every Thor-constructed wrapper/param; value positions bind unbranded objects as parameters. `parameter-encoding.test.ts`, `sql-input-brand.test.ts`. |
| P0.3 | Compiled-query value semantics | **Already fixed (shape-only)** | `.compile()`/`.prepare()` throw `GuardError guard:"prepared-values"` on captured inline values; `inspectIr` separates params from constants. `compiled-constants.test.ts`. |
| P0.4 | Migration policy on manual exec | **Confirmed, fixed** | `guardManualMigration` runs per step before SQL reaches the driver; the whole pending set is preflighted; `up`/`down` gated independently by `safety`/`phase` and `downSafety`/`downPhase`; unmarked = blocked under `safe-only`. `migration-policy.test.ts`. |
| P0.5 | `.one()`/`.maybeOne()` cardinality | **Confirmed, fixed for SELECT and DML result consumption** | SELECT uses a memoized `LIMIT 2` probe. DML `RETURNING.one()`/`.maybeOne()` passes `maxRows: 2` through the driver contract, bounding materialization and decoding without pretending to undo the mutation. `cardinality-probe.test.ts`, `returning-cardinality.test.ts`, `cardinality-observability.test.ts`. |
| P0.6 | Degenerate public shapes | **Confirmed, fixed** | Empty `inArray`/`or` → FALSE, empty `notInArray`/`and` → TRUE; pagination rejects non-finite/negative/fractional; empty inserts rejected. `invalid-shapes.test.ts`, property invariants. |

## Priority 1 — resource & concurrency hardening

| # | Finding | Verdict | Correction & tests |
|---|---|---|---|
| P1.1 | Misleading pool layers | **Reframed** | Renamed to `PostgresDedicatedPoolConnectionLayer` / `MySQLDedicatedPoolConnectionLayer` with explicit one-connection semantics. `scoped-layers.test.ts`. |
| P1.2 | Unbounded prepared resources | **Confirmed, fixed (+ adversarial follow-up)** | `Driver.releasePrepared`/`clearPrepared` + connection-scoped bounded admission. `Driver.preparedScope` keys by physical client; execution leases prevent active eviction; clients without safe release (including MySQL without `unprepare`) stop admitting at the bound; SQLite transient statements finalize on every completion path where supported. `query-cache.test.ts`, `prepared-default-bound.test.ts`, `prepared-eviction-race.test.ts`, `sqlite-collision-leak.test.ts`, `sqlite.test.ts`, `mysql.test.ts`. |
| P1.3 | MySQL prepared semantics | **Confirmed, fixed** | `preparedStatements:false` → `query(sql,values)`; enabled → `execute`; `undefined` binds normalized to `null` so both paths agree. `mysql.test.ts`. |
| P1.4 | Weak migration checksums | **Confirmed, fixed (+ follow-up)** | `sha256:v1:<digest>` over canonical id/name/up/down/revision/irreversible/safety/phase/downSafety/downPhase; legacy FNV rows verified read-only. **Review found no upgrade path for legacy MySQL `varchar(64)` journals** (a 74-char digest would overflow) — fixed with an in-place `upgradeJournal` that widens the column before the first sha256 write. `migrate.test.ts`, `migrator.test.ts`, property. |
| P1.5 | Implicit unsafe SQL paths | **Confirmed, fixed (+ follow-up)** | Structured window-frame DSL; SQL defaults/generated/check/routine-DDL require `unsafeSql`. **Review found `over()` and routine-DDL fields lacked runtime tag checks, and MySQL literal defaults didn't escape backslashes** — all fixed (`assertWindowFrame`, `unsafeSyntax`, backslash escaping). `advanced-query.test.ts`, `migrate.test.ts`, `schema.test.ts`. |

## Priority 2 — v1 contract reconciliation

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| P2.1 | `stream()` | **Deferred** | Removed from the stable terminal list and feature matrix; `query.streaming` unsupported on every dialect; docs/spec/skills/limitations say deferred. |
| P2.2 | Public subpaths | **Reconciled** | `/ir /guards /bench /runtime` intentionally unexported; IR/cache internals sealed from the root and enforced by the packed consumer + stability checker. |
| P2.3 | Migration claims | **Partial, documented** | Docs scope generation to create-table only; expand/contract, alteration, index/enum/view/routine generation, and seed workflows are explicitly deferred. |
| P2.4 | Drift semantics | **Reconciled** | Structural `Introspector.drift` vs legacy create-missing-table `Migrator.drift` distinguished in code JSDoc and docs. `drift.test.ts` covers every structural case. |
| P2.5 | Routine completeness | **Partial, documented** | Advanced named/default/overloaded/OUT args, procedure decoding, and introspection enumerated as deferred. |

## Priority 3 — testing, quality & release gates

| # | Item | Status |
|---|---|---|
| P3.1 | Coverage thresholds | **Done** — global floors (87/78/86/89) + stricter per-module floors (transaction, run-pipeline, migrator, guards) in `vitest.config.ts`; `test:coverage` enforces them and runs in CI. |
| P3.2 | Repo-wide Biome | **Done** — `quality:check` is now `biome ci . && knip`; the repo is formatted; intentional-style rules disabled with rationale; genuine findings fixed. |
| P3.3 | Packed exports | **Done** — every subpath imported under Node+Bun, internal-leak assertions, tarball hygiene, and a **new typed-consumer `tsc` compile** against the packed `.d.ts`. |
| P3.4 | API-stability manifest | **Done** — `docs/api-manifest.json` drives the checker; it now also diffs the export map, tagged-error set, capability-name set, and stable CLI commands against the manifest (drift fails in both directions). |
| P3.5 | Property/fuzz | **Done** — added pagination-guard, empty-list lowering, identifier quoting, checksum determinism, policy monotonicity, and prepared-cache-bound properties; deterministic `FC_SEED`. |
| P3.6 | CI & branch protection | **Verified** — CI runs on `main`, actions SHA-pinned, minimal permissions, ref-scoped concurrency, perf gate hard-fails on missing baseline, e2e preflight prevents silent DB skips, coverage+quality enforced. **Open owner action: `main` has no branch protection** (a GitHub setting, not a file); recommended `gh api` command in [remediation-p0-report.md](./remediation-p0-report.md#p36). |

## Priority 4 — documentation & positioning

- **P4.1** Conformance matrix added to [limitations.md](./limitations.md) (per-feature implemented/tested-where/documented/stable).
- **P4.2** Versions set to `0.1.0-alpha.1`; README/limitations describe Thor as alpha; `1.0.0` reserved for post-external-use.
- **P4.3** [limitations.md](./limitations.md) records runtime/database support, migration/drift/routine/streaming/prepared/pool limits, and the raw-SQL trust boundary.
- **P4.4** Review reference [thor-repository-review.md](./thor-repository-review.md) present; `docs:check` confirms all links resolve.

## Adversarial follow-up

The later [adversarial audit](./adversarial-test-audit.md) found additional
snapshot, prepared-lifecycle, scope, migration-authenticity, and documentation
defects. Their reconciled status and the work still not implemented are recorded
in [remediation-adversarial-report.md](./remediation-adversarial-report.md). This
project remains alpha; the historical validation below is not evidence that live
database lanes were rerun for the later fixes.

## Final validation

Run on this host (Node 26, Bun 1.3, Docker available):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ executed |
| `pnpm build` / `pnpm typecheck` / `pnpm test:types` | ✅ executed |
| `pnpm test` | ✅ 874 passed, 147 skipped (env-gated e2e files) |
| `pnpm test:coverage` | ✅ passed thresholds — 89.95% stmts / 80.96% branch / 90.08% funcs / 91.49% lines |
| `pnpm test:property` | ✅ 22 passed |
| `pnpm docs:check` | ✅ passed |
| `pnpm quality:check` | ✅ passed (repo-wide biome + knip) |
| `pnpm test:packages` | ✅ Node packed consumer + typed compile |
| `pnpm test:runtime:node` | ✅ 13 passed |
| `pnpm test:runtime:bun` | ✅ 68 passed |
| `pnpm e2e` (Postgres + MySQL) | ✅ **executed** — 147/147 passed against Docker Postgres 17 + MySQL 8.4 |
| `pnpm bench:gate:node` | ✅ passed committed baseline (warm 4.53 µs; aspirational ≤2 µs still over) |
| `pnpm bench:gate:bun` | ✅ passed committed baseline (warm 3.84 µs) |

No lane was reported as passing through a skip; the e2e lane was executed with
real databases.

## Recommendation

**Alpha remediation baseline complete.** All six release-blocking P0 defects — including the
object-value injection hole the adversarial review surfaced — are fixed and
regression-tested; P1 resource/concurrency hardening is complete with the
per-connection and journal-upgrade follow-ups; the spec, exports, drift, and
streaming claims are reconciled; and coverage, repo-wide quality, a
manifest-driven API gate, expanded property tests, a typed packed-consumer
check, and the live-database and dual-runtime lanes recorded in this historical
pass were green. Promotion beyond alpha should wait on the remaining work in the
final adversarial report, including live stress and boundary verification. Promotion to a
release candidate should wait on: the deferred migration-generation, routine,
and streaming surfaces being either implemented or held as explicit non-goals;
and branch protection being enabled on `main` (owner action). Reserve `1.0.0`
for a deliberate stable release after external application use.
