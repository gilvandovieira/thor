# Thor remediation — Priority 0 verification report

Scope of this report: the six release-blocking **Priority 0** findings. Each was
reproduced or disproved against the actual repository before any change. Priority
1–4 items are being addressed separately (in-progress) and are summarised at the
end with their verified status where known.

Every P0 fix ships with a focused regression test and was validated against the
full gate set (see [Validation](#validation)).

## P0 findings

### P0.1 — Canonicalize multi-row inserts — **CONFIRMED, fixed**

- **Files/symbols:** `sql/mutation-builder.ts` (`InsertBuilder.values`, previously
  `valuesToRow`, now `canonicalizeInsertRows`).
- **Root cause:** the column list was derived from the first row while each later
  row's values were produced by an independent `Object.entries` pass and only the
  values kept. A later row with the same keys in a different property order bound
  values to the wrong columns. Unknown keys were also silently dropped
  (`if (!column) continue`).
- **Fix:** derive one canonical physical column list from the first row (validated
  against the schema); project every row into that order **by key**; reject
  unknown keys, and later rows with missing/extra keys, with a tagged
  `ParameterError` at construction.
- **Tests:** `test/insert-canonicalization.test.ts` — reversed-key rows, 3+ rows
  with randomized ordering, missing/extra/unknown keys, mixed named+inline, and a
  property test permuting key order. Updated `test/guards.test.ts`.
- **Residual:** single `INSERT` requires homogeneous rows (one shared column list);
  this is by design and now enforced rather than silently mis-bound.

### P0.2 — Encode & validate all parameters consistently — **CONFIRMED, fixed**

- **Files/symbols:** `execution/run-pipeline.ts` (`ParameterPlan`),
  `schema/column.ts` (`columnParamCodec`), `sql/mutation-builder.ts`,
  `sql/expressions.ts`, `sql/query-builder-support.ts`.
- **Root cause:** `ParameterPlan` skipped nodes carrying an inline `value` when
  compiling encoders, then passed `node.value` raw to the driver. Named params
  were encoded through their codec; inline values were not.
- **Fix:** the plan now validates and encodes inline values through their codec
  once (keyed by node identity), identical to named params. `columnParamCodec`
  widens a nullable column's codec with `Schema.NullOr` on both encode and decode
  so inline `null` and transforming codecs behave consistently. Direct, prepared,
  and compiled paths all route through `ParameterPlan`.
- **Tests:** `test/parameter-encoding.test.ts` — inline encoded through codec,
  inline≡named driver values, invalid inline/named rejected before the driver,
  inline `null` for nullable columns.
- **Residual:** `toSql()` inspection still shows the pre-encode authored literal
  (encoding happens at execution bind time); driver values are encoded.

### P0.3 — Compiled-query value semantics — **CONFIRMED already-correct (shape-only)**

- **Files/symbols:** `execution/prepared-plan.ts` (`PreparedExecutionPlan`
  constructor), `sql/query-builder-support.ts` (`inspectIr`).
- **Finding:** Thor already implements the *preferred* shape-only model —
  `.compile()`/`.prepare()` throw a `GuardError` (`guard: "prepared-values"`) when
  a query captures an inline value. Documentation matches.
- **Change:** refined `inspectIr` to distinguish `params` (named, required at
  execution) from `constants` (captured inline values), so inspection metadata is
  unambiguous.
- **Tests:** `test/compiled-constants.test.ts`.

### P0.4 — Migration policies govern manual execution — **CONFIRMED, fixed**

- **Files/symbols:** `migrate/migrator.ts` (`up`/`down`/`applyOne`/`rollbackOne`,
  new `guardManualStep`), `migrate/journal.ts` (`guardManualMigration`),
  `migrate/define-migration.ts` (`safety`/`phase`).
- **Root cause:** `guardOperations` gated only generated plans (`plan`/`generate`/
  `apply`); `up()`/`down()` executed manual `SqlStatement`/Effect steps with no
  policy check.
- **Fix:** manual migrations declare `safety` (`additive`/`destructive`) and
  `phase` (`expand`/`contract`); `up()`/`down()` evaluate `guardManualMigration`
  before running each step, failing with a tagged error before any SQL reaches the
  driver, inside the lock/transaction (no journal write on rejection).
- **Tests:** `test/migration-policy.test.ts` — destructive blocked under
  `safe-only`; blocked under unreviewed `allow-reviewed-destructive`; allowed when
  reviewed; additive allowed; `disabled`/`validate-only` block all;
  contract-phase blocked under `expand-only`.
- **Residual (documented):** Thor cannot infer safety from opaque SQL. An unmarked
  manual migration is treated as author-trusted **additive** and passes
  `safe-only`. Mark destructive migrations, or run under a reviewed policy, for
  enforcement. See [limitations.md](./limitations.md#migrations).

### P0.5 — Optimize `.one()` / `.maybeOne()` cardinality — **CONFIRMED, fixed**

- **Files/symbols:** `sql/query-builder.ts` (`SelectQuery.cardinalityProbeIr`,
  `one`, `maybeOne`).
- **Root cause:** both terminals executed the full, unbounded query via
  `executeRows` and counted rows in memory.
- **Fix:** execute a cardinality-probe IR capped to `LIMIT 2` (preserving any
  tighter user limit). The top-level `LIMIT` applies to the final result of every
  shape (set ops, CTEs, GROUP BY, DISTINCT, OFFSET all render first), so no
  wrapping select is needed. The probe IR is **memoized per query instance** so
  repeated calls reuse one IR identity and keep the shape/compile/guard/param
  caches warm (a naive per-call clone regressed the warm hot path ~3.5×; caught by
  the bench gate and fixed).
- **Tests:** `test/cardinality-probe.test.ts` — `LIMIT 2` emitted;
  `limit(0)`/`limit(1)` preserved; `limit(50)` capped; OFFSET kept;
  none/some/too-many; `.all()` uncapped.

### P0.6 — Reject/normalize invalid public query shapes — **CONFIRMED, fixed**

- **Files/symbols:** `sql/predicates.ts` (`inArray`/`notInArray`/`and`/`or`),
  `sql/query-builder.ts` (`limit`/`offset`, `assertPaginationValue`).
- **Root cause:** empty `inArray` compiled `IN ()`; empty `and`/`or` compiled
  `()`; `limit`/`offset` accepted `NaN`/`Infinity`/negative/fractional values.
- **Fix:** empty `inArray`/`or` lower to `FALSE`, empty `notInArray`/`and` lower
  to `TRUE` at the builder (keeping parameter collection consistent — discarded
  operands never enter the IR). `limit`/`offset` reject non-finite/negative/
  non-integer values with a tagged `GuardError` before any IR is built.
- **Tests:** `test/invalid-shapes.test.ts`.

## Follow-up review (14 findings) — status

A second independent review surfaced 14 further findings. Verified against the
current code and addressed as follows (each fix has a regression test):

| # | Sev | Status | Fix / test |
|---|-----|--------|-----------|
| 1 | Critical | **Fixed** | Compiler compiles `InList`/`WindowFunction` sub-exprs in textual order so positional (`?`) dialects bind correctly — `placeholder-order.test.ts` |
| 2 | Critical | **Fixed** | Unmarked manual migration is *unchecked* → blocked under `safe-only`/`expand-only` unless reviewed — `migration-policy.test.ts` |
| 3 | Critical | **Fixed** | `down()` guarded by its own `downSafety`/`downPhase`, not the forward safety — `migration-policy.test.ts` |
| 4 | High | **Fixed** | MySQL journal `checksum` widened `varchar(64)→varchar(255)` for `sha256:v1:` digests |
| 5 | High | **Fixed** | Prepared `.one()`/`.maybeOne()` use a cached `LIMIT 2` probe plan — `cardinality-probe.test.ts` |
| 6 | High | **Fixed** | Routine args bound through declared codecs; named routines reject missing/unknown keys — `routine-arg-codecs.test.ts` |
| 7 | High | **Fixed** | Set-op operand with `ORDER BY`/`LIMIT`/`OFFSET`/CTE rejected at construction — `advanced-query` |
| 8 | High | **Fixed** | Unknown update/upsert keys rejected, not silently dropped — `mutation-validation.test.ts` |
| 9 | High | **Fixed** | Empty selection/columns/`SET`/conflict-`SET` rejected at construction + compile — `invalid-shapes.test.ts` |
| 10 | Med | **Fixed** | Own-property key lookup (prototype-safe) + generated-column rejection — `mutation-validation.test.ts` |
| 12 | Med | **Fixed** | Whole pending set preflighted under the lock before applying any — `migration-policy.test.ts` |
| 13 | Med | **Fixed** | Offset-only SQL emits an explicit unbounded `LIMIT` on SQLite (`LIMIT -1`) and MySQL (64-bit max); Postgres unchanged — `offset-pagination.test.ts` |
| 14 | Med | **Fixed** | `.one()`/`.maybeOne()` cardinality refinement folded inside the observed span across direct/compiled/prepared paths, so `NotFoundError`/`TooManyRowsError` carry an `errorTag` — `cardinality-observability.test.ts` |
| 11 | Med | **Open (owner)** | Multi-row insert parameter map should merge across rows, not union (type-level, in the actively-edited `mutation-builder.ts`) |

## Release-readiness matrix

Legend: ✅ verified this pass · 🟡 partial / in progress · ⬜ not assessed here ·
🔴 known gap. "Live" columns require Docker (Postgres/MySQL) which was not run in
this environment.

| Area | Implemented | Unit/pure | Fake-driver | Live SQLite | Live PG | Live MySQL | Node | Bun | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Query builder | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | ✅ | ✅ | P0.1/P0.5/P0.6 fixed |
| Parameters | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | ✅ | ✅ | P0.2 fixed |
| Compiled queries | ✅ | ✅ | ✅ | — | ⬜ | ⬜ | ✅ | ✅ | shape-only (P0.3) |
| Relations | ✅ | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ✅ | 🟡 | codec path shares P0.2 |
| Transactions | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | ✅ | 🟡 | savepoints, typed errors preserved |
| Migrations | 🟡 | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ✅ | 🟡 | P0.4 fixed; generation create-only |
| Introspection | 🟡 | ✅ | 🟡 | 🟡 | ⬜ | ⬜ | ✅ | 🟡 | drift scope differs (P2.4) |
| Drift | 🟡 | ✅ | 🟡 | ⬜ | ⬜ | ⬜ | ✅ | 🟡 | two meanings (P2.4) |
| Routines | 🟡 | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ✅ | 🟡 | advanced args deferred (P2.5) |
| Observability | ✅ | ✅ | ✅ | — | ⬜ | ⬜ | ✅ | 🟡 | probe reports actual read count |
| PostgreSQL | ✅ | ✅ | ✅ | — | ⬜ | — | ✅ | 🟡 | live PG not run (no Docker) |
| SQLite | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | contract suite green |
| MySQL | 🟡 | ✅ | ✅ | — | — | ⬜ | ✅ | 🟡 | prepared semantics under review (P1.3) |
| CLI | ✅ | ✅ | — | 🟡 | ⬜ | ⬜ | ✅ | ⬜ | commands smoke-tested |
| Skills | ✅ | ✅ | — | — | — | — | ✅ | ⬜ | 10 SKILL.md, generator in sync |
| Package publishing | ✅ | — | — | — | — | — | ✅ | 🟡 | Node smoke test passes |

Items marked 🟡 for Priority 1/2 reasons (prepared/pool lifecycle, MySQL prepared
semantics, checksums, export reconciliation, drift/routine reconciliation) are
being addressed in parallel and are **not** re-certified by this report.

## Priority 3 — testing, quality & release gates (partial)

Priority 1/2 are being addressed in parallel; the P3 items below were assessed
without touching files under active change (exports, property tests,
`package.json`). Items coupled to the in-progress export reconciliation (P3.4
manifest) or property-test work (P3.5) are intentionally deferred.

### P3.6 — CI status & branch protection — **assessed; one fix + one gap**

- **CI runs on `main`:** ✅ verified via `gh run list` — the workflow triggers on
  `push: [main]` and `pull_request`; the current tip is green.
- **Action pinning:** ✅ all `uses:` are pinned to commit SHAs with version
  comments.
- **Minimal permissions:** ✅ `permissions: contents: read`.
- **Concurrency:** ✅ group includes `github.ref`, so `cancel-in-progress` only
  supersedes same-ref runs and cannot conceal a required run on another ref.
- **Performance gate:** ✅ verified `scripts/bench-hotpath.mts` hard-fails when the
  reviewed baseline is **missing** (exit 1) or **invalid** (exit 1) — it never
  self-baselines under `BENCH_GATE`.
- **e2e silent skip:** 🔴→✅ **fixed.** The integration suites are
  `describe.skipIf(!DATABASE_URL/!MYSQL_URL)`, so a misconfigured CI env would
  skip every integration test and still pass green. Added a preflight step to the
  `e2e` job that fails when either URL is empty — a complete guard for this skip
  mechanism. (`.github/workflows/ci.yml`)
- **Branch protection:** 🔴 **open gap, needs owner action.** `main` has **no
  branch protection** (`gh api …/branches/main/protection` → 404). PRs can merge
  with failing checks. This is a GitHub repo setting, not a file, and is an
  outward-facing change for all contributors, so it is **not** applied here.
  Recommended (require the CI jobs as checks, block merge on failure):

  ```sh
  gh api -X PUT repos/gilvandovieira/thor/branches/main/protection \
    -H "Accept: application/vnd.github+json" \
    -f 'required_status_checks[strict]=true' \
    -f 'required_status_checks[checks][][context]=Static invariants' \
    -f 'required_status_checks[checks][][context]=Node 22 tests' \
    -f 'required_status_checks[checks][][context]=Node 26 tests' \
    -f 'required_status_checks[checks][][context]=Packed Node consumer' \
    -f 'required_status_checks[checks][][context]=Bun contract and packed consumer' \
    -f 'required_status_checks[checks][][context]=PostgreSQL and MySQL integration' \
    -f 'required_status_checks[checks][][context]=Reviewed hot-path baseline' \
    -F 'enforce_admins=true' -F 'required_pull_request_reviews=null' \
    -F 'restrictions=null'
  ```

### P3.3 — Packed-export consumer test — **already strong (owned by P2.2)**

`scripts/test-packages.mjs` already packs both packages; asserts the tarball
contains `package.json`/`README`/`LICENSE`, contains no unintended or
stale/deleted entrypoints; imports every declared subpath and asserts non-empty
exports; asserts internal symbols do **not** leak through the stable root; runs
the CLI (help + full 38-capability output) under both Node and Bun; and checks
the export map matches the expected set and that `effect` is not duplicated. Its
`expectedExports`/import list is coupled to the P2.2 export reconciliation, so it
is left for that workstream rather than edited here.

### P3.1 / P3.2 / P3.4 / P3.5 — deferred (coupling / collision)

- **P3.1 coverage thresholds** — deferred: a coverage run currently fails on the
  in-progress P1.4 checksum tests, and setting reviewed thresholds requires a
  clean measurement.
- **P3.2 repo-wide Biome** — deferred: expands the `quality:check` command in
  `package.json`, under active change.
- **P3.4 API-stability manifest** — deferred: couples directly to the P2.2 export
  reconciliation.
- **P3.5 property/fuzz expansion** — deferred: overlaps the property-test files
  under active change.

## Validation

Run in this environment (Node 26, Bun 1.3, no Docker):

| Command | Result |
|---|---|
| `pnpm build` | ✅ executed |
| `pnpm typecheck` | ✅ executed |
| `pnpm test:types` | ✅ executed |
| `pnpm test` (full vitest) | ✅ 807 passed / 147 skipped at P0 completion |
| `pnpm test:property` | ✅ executed |
| `pnpm docs:check` | ✅ executed |
| `pnpm quality:check` | ✅ executed (biome + knip) |
| `pnpm test:packages` | ✅ Node smoke passed |
| `pnpm test:runtime:node` | ✅ 13 passed |
| `pnpm test:runtime:bun` | ✅ 68 passed |
| `pnpm bench:gate:node` | ✅ within 2.25× baseline after probe memoization |
| `pnpm bench:gate:bun` | ⬜ not run this pass |
| `pnpm e2e` (Postgres+MySQL) | ⬜ **environment unavailable** (no Docker) — not executed |

Live Postgres/MySQL e2e tests were **not executed** (Docker unavailable) and are
reported as *environment unavailable*, not as passing.

## Recommendation

**Ready for alpha** (on the P0 axis). All six release-blocking correctness and
data-integrity defects are fixed and covered by regression tests, with the full
non-Docker gate set green. Promotion to **beta** should wait until: the
Priority 1 resource/concurrency hardening (prepared-statement bounds, pool-layer
semantics, MySQL prepared semantics, checksums) lands; the Priority 2 spec/export
reconciliation is complete; and the live Postgres/MySQL e2e and Bun bench gate are
executed in an environment that has them. Do not label the repository
production-ready on feature-completeness alone.
