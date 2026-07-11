# Adversarial runtime remediation report

Date: 2026-07-11

Thor remains **`0.1.0-alpha.1`**. This report reconciles the historical
[adversarial audit](./adversarial-test-audit.md), the preserved remediation
branch, and the additional contract/live work completed afterward.

## Repository-state preservation

- Historical audit base: `main` at `97283db`, with a dirty remediation tree and
  untracked `packages/thor/src/ir/unsafe-sql.ts`. The exact historical file list
  and baseline are retained in `docs/adversarial-test-audit.md`.
- Preserved state at the start of this completion pass: clean
  `remediation/adversarial-runtime` at `fcde9e784dcd64672880626ebfa38477c302757e`.
  Its working-tree diff and untracked-file list were both empty.
- Safe completion branch: `remediation/adversarial-complete`, created from that
  exact clean state. No adversarial test was reset, discarded, regenerated,
  weakened, skipped, or quarantined.
- Preservation lineage: `85e7928` (pre-audit remediation), `f482a56`
  (adversarial baseline), `2dc6ac8` (confirmed runtime fixes), and `fcde9e7`
  (initial reconciliation), followed by reviewable completion commits.

## Confirmed defects

| Finding | Verdict and root cause | Production correction and lifecycle | Evidence / behavior matrix |
|---|---|---|---|
| Prepared snapshot mutation | Fixed. Builder IR, raw arrays, params, aliases, nested queries, CTEs, sets, windows, mutation rows, conflicts, returning fields, and source metadata were reachable after plan creation. | `snapshotQueryIR` owns/freeze-copies the graph before normalization, guard/hash/parameter/decoder construction. Schema encoders/decoders are compiled at preparation. Lexical source tokens are immutable and hash-independent. | `prepared-snapshot-mutation.test.ts` now covers raw text, params, windows, CTE/set operands, mutations, table/column metadata, SQL, cache key, and inspection. Direct construction snapshots inline data; prepared/compiled reject captured inline values. Node/Bun-neutral. Driver sees only frozen SQL/bindings. |
| Inline mutable values | Contract resolved: snapshot at query construction. The earlier policy retained mutable opaque instances. | Arrays, records/accessors, dates, ArrayBuffers, typed arrays/Buffers, maps, and sets are recursively copied. Frozen domain instances are accepted; mutable opaque class instances reject with an actionable error and must be named execution values. | `parameter-encoding.test.ts` covers repeated/concurrent execution, nested records, dates, binary values, maps/sets, null prototypes, and frozen/mutable domain instances. |
| Active prepared eviction | Fixed. Registry entries previously had no complete execution lease. | Every driver Effect owns one idempotent lease finalizer. Eviction selects only idle entries. Release occurs before registry deletion/admission; failure retains truthful state and bypasses the new admission. | `prepared-eviction-race.test.ts`, `query-cache.test.ts`; success, failure, cancellation/defect finalization use `Effect.ensuring`. No driver release occurs with an active lease. |
| MySQL false native bound | Fixed. mysql2 `execute()` could cache statements while Thor evicted only its own name. | Without `unprepare`, `releasePrepared` is absent and admission stops at capacity. With it, idle resources are physically released. Per-client registries survive driver recreation. Metrics expose admissions, capacity bypasses, releases, failures, and actual admitted size. | `prepared-default-bound.test.ts`, `mysql.test.ts`, `prepared-resource-live.e2e.test.ts`; live MySQL `Prepared_stmt_count` stays within the configured bound with and without unprepare. |
| DML returning materialization | Fixed/restricted truthfully. Core passed no transport bound; postgres.js and non-iterable SQLite paths still sliced materialized arrays. | Drivers accept `maxRows`. node-postgres uses its protocol row bound; Node/Bun SQLite stop iteration after two; postgres.js uses `unsafe(...).cursor(2, ...)` and `CLOSE`. Structural wrappers without cursor/iterator reject before statement execution. MySQL capability rejection remains before driver I/O. | Unchanged `returning-cardinality.test.ts` covers insert/update/delete, one/maybeOne, direct/prepared/compiled, and 10,000-row fakes. `dialects.test.ts` proves postgres.js consumes two. Node and Bun SQLite runtime lanes execute returning. |
| SQLite transient leaks | Fixed. Unnamed and collision fallback statements had no owner finalizer. | One-shot statements finalize in `finally`; cached statements finalize only on eviction/disposal. Driver maps do not delete until finalization succeeds. | `sqlite-collision-leak.test.ts`, `sqlite.test.ts`, and Bun-native counters: transient, command, collision, cached, failure, and disposal paths finalize exactly once. |
| Nested mutation scope bypass | Fixed. Scope was shallow and name-only, so shadowed aliases were ambiguous. | One recursive expression/subquery visitor covers rows, assignments, conflicts, returning, windows, raw structural columns, CTEs, sets, routines, scalar/EXISTS/IN subqueries, and correlations. Opaque source identity plus name→identity lexical maps enforce shadowing. | `nested-scope-guards.test.ts` covers invalid update/delete, valid correlation, accidental same-name shadowing, and two aliases of one table. Rejection precedes driver access and compile; valid correlation executes. |
| Window grammar gaps | Fixed. Endpoint rank checks admitted prohibited unbounded endpoints and truthiness confused absence with forged falsy values. | Runtime validation uses `frame !== undefined`, validates units/tags/own offsets, and rejects prohibited/reversed boundaries and unauthentic unsafe SQL. | Unchanged `window-frame-forgery.test.ts`: 11/11 pass; no driver access. |
| Migration statement impersonation | Fixed. `_tag` alone was treated as authority. | `sql`/`sqlStatement` register frozen objects in a versioned weak authenticity registry; proxies, inherited/getter values, JSON, and non-string payloads reject. CLI localization remains defensive. | Unchanged `migration-statement-authenticity.test.ts`; driver is never reached for rejected statements. Generated/manual migration loading remains green. |
| MySQL journal upgrade race | Fixed and live-proven. `status`/`dryRun` previously upgraded outside the named lock. | `ensureJournalUnlocked` is called only inside `serializeJournal`/already-locked flows; no recursive lock. Probe/ALTER/read are serialized and idempotent. | `journal-upgrade-live.e2e.test.ts`: two physical connections race a legacy `varchar(64)` journal, both statuses succeed, width becomes 255, SHA-256 data fits. |
| README migration contradiction | Fixed. Example omitted safety but invoked default safe-only `up`. | Example declares additive/expand forward metadata and destructive/contract rollback metadata; reviewed rollback is documented. | Unchanged `migration-safety-docs.test.ts`, README example compiler/checker, docs and generated skills. |

## Previously disproved or already fixed

No regression was found in same-realm `UnsafeSqlNode` forgery rejection,
collision wrong-SQL fallback, default observability redaction, strict duplicate
named-parameter policy, flat raw-expression scope traversal, default prepared
limit 100, invocation-scoped CLI review, SQLite redo atomicity, existing window
offset validation, or primary migration safety documentation. The 13 original
passing adversarial tests remain permanent regression tests.

## Ambiguous contracts resolved

- **Inline values:** snapshot at construction for supported containers; mutable
  opaque instances reject. Named params read/encode one invocation's supplied
  value.
- **Package copies:** compatible physical Thor copies in one JavaScript realm
  interoperate through authenticity protocol v1. Genuine unsafe SQL,
  `SqlStatement`, columns, params, expressions, tables, routines, and structural
  migration operations work across copies; plain/JSON lookalikes do not. The
  threat model is untrusted data, not hostile same-realm code that can already
  import unsafe constructors. Cross-realm/incompatible protocols reconstruct.
- **Migration statements:** authenticated constructors, not structural trust.
- **Identifiers:** empty and NUL reject before compilation. Quotes/backticks,
  whitespace/newlines, Unicode/emoji, reserved words, and dots are opaque quoted
  content. Dots do not qualify. Backend byte limits/truncation remain backend
  enforced.
- **DML cardinality:** bounded where a transport iterator/cursor exists;
  structural adapters missing that surface reject rather than materialize.

## Previously untested areas now covered

- Live PostgreSQL `pg_prepared_statements` and MySQL `Prepared_stmt_count` bounds,
  reuse, with/without unprepare, and registry/native equivalence.
- 10,000 unique prepared shapes in a dedicated stress lane: bound 100, 9,900
  physical releases, and less than 256 MiB heap growth.
- Concurrent live MySQL journal upgrade on two physical connections.
- Live PostgreSQL redo reapply failure: schema and journal both restored by the
  transaction.
- Live MySQL redo reapply failure: documented schema-present/journal-missing
  partial state and idempotent recovery.
- Same-realm two-copy built-package fixture for SQL, statements, schema/query,
  routine, and migration values.
- Relation boundaries 0/1/799/800/801, duplicate/null/empty behavior, composite
  width rejection, ordering/association, and observable chunk calls.
- Identifier unit/property matrix and opaque-dot behavior.
- Driver-message/credential/email/binary/large-value default observability probes.
- Bun-native statement prepared/finalized/active counters.
- Savepoint creation/release/rollback-to failure, combined cleanup causes,
  interruption, defects, and retry boundaries.

## Resource and dialect details

- Prepared metrics distinguish native hit/miss (cache counters), admission,
  admission bypass, physical release, and release failure. `size` is the actual
  physical-admission registry, not a configured target.
- PostgreSQL without an explicit deallocator stops admission. Connection close is
  the final physical release boundary. MySQL/SQLite delete registry entries only
  after successful unprepare/finalize.
- DML mutation effects are not rolled back merely because `.one()` observes two
  rows and raises `TooManyRowsError`; the bounded contract concerns rows read and
  decoded, not mutation atomicity.
- MySQL DDL remains non-transactional. `redo` holds one named lock, but recovery
  must reconcile schema and journal as described in `docs/migrations.md`.

## Remaining limitations

- **Not implemented:** a cursor/streaming public terminal.
- **Deferred with explicit reason:** backend-specific identifier byte-length and
  truncation-collision prevalidation; those rules vary by server/object kind and
  are currently backend enforced.
- **Partial evidence:** the two-copy fixture copies built package output into two
  physical module roots; it is not yet a mixed-minor/version compatibility lane.
- **Partial evidence:** the 10,000-shape heap stress uses deterministic fake
  transport plus separate live native-count tests; a 100,000-shape long-lived
  three-database heap/latency soak remains a non-default operational exercise.
- **Partial evidence:** relation 800/801 boundaries are deterministic fake-driver
  tests, not a three-backend payload/packet live matrix.
- **Not implemented:** forced network loss exactly during MySQL redo and pool
  release/reacquisition stress across multiple pool implementations.

None of these remaining items is represented as passing. They prevent a release
candidate claim, but do not re-open the corrected silent SQL mutation, wrong-SQL,
active-release, false-bound, scope, cleanup, or migration-authenticity defects.

## Verification

Final validation was executed on 2026-07-11. The complete captured output is in
`/tmp/thor-final-validation-20260711.log`; the initial baseline and preserved
adversarial reproduction outputs are in `/tmp/thor-baseline-20260711.log` and
`/tmp/thor-adversarial-current-20260711.log`, respectively.

| Command / lane | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm build` / `pnpm typecheck` / `pnpm test:types` | Passed |
| `pnpm test` | 65 files passed, 7 environment-gated files skipped; 965 tests passed, 154 skipped |
| `pnpm test:coverage` | Passed: 90.49% statements, 81.62% branches, 90.92% functions, 92.02% lines |
| `pnpm test:property` | 4 files, 27 tests passed |
| `pnpm docs:check` | Passed: 92 modules, 39 stability anchors, 14 exports, 15 error tags, 34 capabilities, 11 README syntax examples, 1 executable README query, 10 generated skills |
| `pnpm quality:check` | Passed: Biome checked 203 files; Knip passed |
| `pnpm test:packages` | Node package smoke passed |
| `pnpm test:runtime:node` | 13 tests passed |
| `pnpm test:runtime:bun` | 69 tests passed, 0 failed |
| `pnpm e2e` | PostgreSQL, MySQL, and SQLite: 7 files, 154 tests passed, 0 skipped |
| `pnpm test:stress` | 1 deterministic 10,000-shape resource/heap test passed |
| `pnpm bench:gate:node` | Passed; warm 4.87 us, prepared 5.20 us, compiled 4.53 us, compiled-prepared 4.85 us |
| `pnpm bench:gate:bun` | Passed; warm 4.16 us, prepared 4.11 us, compiled 4.18 us, compiled-prepared 4.07 us |
| Consolidated mandatory adversarial suite | 12 files, 46 tests passed, 0 failed, 0 skipped |

The 154 ordinary-suite skips are the live-database tests gated when database
URLs are absent. The subsequent Docker E2E invocation executed those 154 tests
and passed all of them; they are not represented as passing in the ordinary
suite. No final validation command failed. The historically reported 24
intentional failures were already corrected in the preserved remediation
lineage before this completion branch was created; the exact historical
failures remain recorded in the audit rather than being misleadingly recreated
against corrected production code.

## Release decision

**Ready for beta.** All adversarial tests and beta blockers are corrected, docs
are aligned, Node/Bun SQLite pass, and the expanded PostgreSQL/MySQL live lane is
green. Release-candidate criteria remain unmet by the explicitly partial
mixed-version, relation-live-boundary, identifier-live-matrix, and extended
pool/network soak items above.
