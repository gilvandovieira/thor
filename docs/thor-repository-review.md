# Independent Review Remediation

This document records the repository review referenced by the roadmap and the
verified remediation status. The current pass began with Priority 2; P0 and P1
remain separate release gates and are not implicitly accepted by this report.

## Priority 2 Verification

| Finding | Classification | Reproduction and root cause | Correction | Residual limitation |
|---|---|---|---|---|
| P2.1 `stream()` | Confirmed | No builder terminal, `Stream` API, cursor-capable `Driver`, per-row decoder, or live test exists. Every driver materializes arrays. | Removed it from the stable v1 terminal contract, marked `query.streaming` unsupported in every matrix, added capability/package checks, and documented deferral in specs and skills. | Real streaming requires a driver-scoped cursor API, interruption-safe finalization, transaction affinity, observability, and live per-adapter tests. |
| P2.2 subpath exports | Confirmed | The spec listed `/ir`, `/guards`, `/bench`, and `/runtime`, while the package exports none. Internal IR/cache symbols leaked from root. | Reconciled the spec to the deliberate package map, removed internal root re-exports, imported internals directly in repository tests/benchmarks, and made packed consumers import every declared export. | Runtime capability APIs remain experimental under `/capabilities`; no public compiler-plugin IR contract exists. |
| P2.3 migration claims | Confirmed | `diff`/`plan`/CLI `generate` compare table names only; `planExpandContract` is a narrow programmatic helper; seeds and broad schema alterations are absent. | Narrowed README/spec/roadmap/skills claims and documented exact manual, generated, backfill, routine-DDL, policy, and dialect boundaries. | General schema diff/generation, portable expand/contract, seed workflows, and plan-journal unification remain release work. |
| P2.4 drift semantics | Confirmed | `Migrator.drift()` returns missing-table `CreateTable` operations; `Introspector.drift()` returns structural `DriftReport`. CLI already uses the latter. | Made `Introspector.drift` canonical in docs, fixed custom-journal parity, preserved composite FK pairing/actions, and expanded drift regression tests. | Legacy `Migrator.drift` needs a deprecation/rename in a coordinated compatibility change; type/default and broader catalog comparison remain deferred. |
| P2.5 routines | Confirmed | Core routine lowering exists, but declared input codecs/shapes, named/default/overloaded/OUT args, procedure decoding, extension verification, retry semantics, and introspection do not. | Reclassified routine completeness, corrected dialect and skill claims, and documented implemented versus advisory metadata. | The missing runtime/type contracts require implementation before routines can be called complete. |

## Evidence

- Streaming: `packages/thor/src/execution/driver.ts`, `packages/thor/src/execution/run.ts`, and capability matrices.
- Exports: `packages/thor/package.json`, `packages/thor/src/index.ts`, and `scripts/test-packages.mjs`.
- Migrations: `packages/thor/src/migrate/ddl.ts`, `expand-contract.ts`, `migrator.ts`, and CLI `generate`.
- Drift: `packages/thor/src/introspect/drift.ts`, `packages/cli/src/commands.ts`, and `packages/thor/test/drift.test.ts`.
- Routines: `packages/thor/src/routine/index.ts`, routine IR/compiler paths, and `packages/thor/test/routine-query.test.ts`.

## Release-Readiness Matrix

| Area | Implemented/tested state | Stability and limitation |
|---|---|---|
| Query builder | Broad DML/advanced SQL; type/unit/fake/live matrix coverage | Stable core; separate P0 correctness gates still govern release |
| Parameters | Named and inline encoding tests exist | P0 verification remains authoritative |
| Compiled queries | Shape-only compiled handles with tests | Stable |
| Relations | Explicit join/batched/manual strategies tested | Experimental |
| Transactions | Effect-native transactions/savepoints and failure tests | Stable core; pool/resource P1 review remains |
| Migrations | Journaled manual execution and create-table generation | Partial; no general schema generator or seed workflow |
| Introspection | Tables/columns/PK/FK/indexes across three dialect strategies | Experimental output; broader catalogs deferred |
| Drift | Structural report with CLI integration | Canonical API is `Introspector.drift`; types/defaults deferred |
| Routines | Core function/aggregate/TVF/procedure lowering | Partial; advanced arguments, input codecs, outputs, introspection deferred |
| Observability | Structured events/spans/redaction tests | Stable configuration surface |
| PostgreSQL | Primary live target | Streaming unsupported; advanced migration/routine gaps remain |
| SQLite | Node/Bun live contract | Stored routines and streaming unsupported |
| MySQL | Compatibility target | Explicitly partial; non-transactional DDL and limited live routine coverage |
| Node | Node 22+ lane | Supported |
| Bun | SQLite/runtime/benchmark lane | Supported subset |
| CLI | Migration/introspection/capability/skills commands | Generation is create-table-only |
| Skills | Ten generated guidance files | Experimental export; corrected to avoid overclaims |
| Package publishing | Packed Node consumer; Bun when requested | Export map now exhaustively imported by smoke test |

## Recommendation

**Ready for alpha.** Priority 2 contract reconciliation is materially improved,
but the repository is not ready for beta until all P0/P1 work is integrated and
the complete release command matrix passes sequentially. It is not a release
candidate or stable release.

## Validation Record

Validation was run sequentially where package builds mutate `dist`:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Executed, passed |
| `pnpm build` | Executed, passed after concurrent driver work settled; a later package run was blocked by concurrent window-frame edits outside this P2 patch |
| `pnpm typecheck` | Executed, passed |
| `pnpm test:types` | Executed, passed |
| Focused P2 tests | Executed, 44 passed (`drift`, capabilities, CLI) |
| `pnpm test` | Executed; 817 passed, 147 environment-skipped, then failed on one P2 test corrected afterward and four concurrent migration-checksum expectations outside this patch |
| `pnpm docs:check` | Failed on missing JSDoc in concurrent MySQL/SQLite prepared-resource additions; P2 API/generated checks pass independently |
| `pnpm quality:check` | Executed, passed |
| `pnpm test:packages` | Baseline executed and passed; final rerun was blocked during build by concurrent window-frame edits before the consumer smoke phase |
| `pnpm test:property` | Baseline executed, 8 passed |
| Coverage, runtime, E2E, benchmark gates | Not reported as passed; final sequential execution remains required after the shared worktree stabilizes |
