# Thor adversarial test audit

> **Historical discovery report.** The red failures and blocker list below record
> the state at audit time. The completed fixes and remaining work are reconciled
> in [remediation-adversarial-report.md](./remediation-adversarial-report.md). Do
> not read this report's retained reproductions as current implementation status.

Date: 2026-07-11

Scope: current working tree, including pre-existing uncommitted remediation work.
This audit added tests and this report only. It did not change production code or
weaken an assertion. Red regression tests are intentionally retained for confirmed
defects.

## Repository and toolchain baseline

The checkout was `main` at `97283db`, tracking `origin/main`, with pre-existing
uncommitted changes in execution, guard, migration, schema, SQL, dialect, docs,
and test files, plus untracked `packages/thor/src/ir/unsafe-sql.ts`. Conclusions
therefore describe the working tree, not pristine `HEAD`.

Versions:

| Component | Version |
|---|---|
| Node | 26.4.0 |
| pnpm | 11.3.0 |
| Bun | 1.3.14 (test runner identified canary build `0d9b296a`) |
| Node SQLite | 3.53.2 (`node:sqlite`) |
| Bun SQLite | `bun:sqlite` from Bun 1.3.14; library version not exposed by the tested API |
| PostgreSQL | 17.10 (`postgres:17-alpine`) |
| MySQL | 8.4.10 Community Server (`mysql:8.4`) |

Initial baseline, before adding adversarial tests:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Executed and passed |
| `pnpm build` | Executed and passed |
| `pnpm typecheck` | Executed and passed |
| `pnpm test:types` | Executed and passed |
| `pnpm test` | Executed: 885 passed, 147 skipped environment-gated live tests |
| `pnpm test:coverage` | Executed and passed: 90.18% statements, 80.90% branches, 90.30% functions, 91.74% lines; same 147 live skips |
| `pnpm test:property` | Executed: 22 passed |
| `pnpm docs:check` | Executed and passed |
| `pnpm quality:check` | Executed and passed |
| `pnpm test:packages` | Executed and passed under Node |
| `pnpm test:runtime:node` | Executed: 13 passed |
| `pnpm test:runtime:bun` | Executed: 68 passed |
| `pnpm e2e` | Executed against live PostgreSQL and MySQL: 147 passed, zero skipped |
| `pnpm bench:gate:node` | Executed and passed committed regression gate; warm 7.51 us |
| `pnpm bench:gate:bun` | Executed and passed committed regression gate; warm 7.36 us |

The 147 ordinary-suite skips are not reported as passes. The separate Docker lane
executed those 147 tests against live databases.

Final consolidated adversarial run: 12 files, 37 tests, 13 passed and 24 failed
across 9 files. Those 24 failures are the intentionally retained defect
reproductions described below; static type checking, documentation checking, and
repository quality checking still pass.

## Reported issues

### 1. Forgeable `UnsafeSqlNode`

- Verdict: **Already fixed for ordinary same-package JavaScript forgery; duplicate-package contract remains ambiguous.**
- Severity: Critical if regressed.
- Public invariant: only `unsafeSql()` can grant dynamic text SQL-syntax meaning.
- Evidence: `unsafe-sql-authenticity.test.ts` passes plain, JSON, inherited,
  proxy, frozen, null-prototype, throwing/changing-getter, and known
  `Symbol.for` brand attempts through query templates, migration `sql`,
  `rawSql`, schema defaults/generated/checks, and windows. The deterministic
  property test passes 500 JSON-reachable forgeries with seed `1414025042`.
- Affected symbols: `createUnsafeSqlNode`/`isUnsafeSqlNode` in
  `src/ir/unsafe-sql.ts`, `rawExpr`, migration `sql`/`rawSql`, schema builders,
  routine migration compilers, and `assertWindowFrame`.
- Driver reached: no. Rejection occurs at construction.
- Why the original finding is now prevented: authenticity is a module-private
  `WeakSet`, not `_tag` or a discoverable global symbol.
- Residual: two physical Thor copies have different registries, so a genuine
  value from copy A is rejected by copy B. Cross-copy behavior was not packaged
  and executed in this pass.
- Release impact: no blocker for ordinary forgery; duplicate-package policy must
  be documented before stable.

### 2. DML `RETURNING .one()` / `.maybeOne()` materialization

- Verdict: **Confirmed. P0.5 was fixed only for SELECT.**
- Severity: High; potentially release-blocking resource exhaustion.
- Public invariant: a cardinality probe reads and decodes at most two rows.
- Minimal reproduction: return 10,000 rows from `insert/update/delete ...
  returning(...).one()`.
- Failing test: `returning-cardinality.test.ts` (7 failures).
- Observed result: `TooManyRowsError.count` is 10,000, not 2, for insert,
  update, delete, maybe-one, direct, compiled, and prepared paths. All rows are
  materialized before refinement by the current `Driver.query` array contract.
- Affected symbols: `ReturningQuery.one`/`maybeOne` in
  `sql/mutation-builder.ts`, `preparedRowsExecution`/`compiledRowsExecution` and
  `exactlyOne`/`atMostOne` in `execution/run.ts`, and
  `PreparedQuery.probePlan` in `sql/query-builder-support.ts`.
- Dialects/runtimes: core behavior affects PostgreSQL and SQLite returning paths
  on Node/Bun. MySQL rejects DML returning before execution.
- Driver reached: yes.
- Root cause: SELECT creates a `LIMIT 2` probe IR; mutation IR is passed through
  unchanged and the driver contract exposes no bounded/cursor read.
- Recommended correction: add a driver-level bounded row probe/cancellation
  contract or safe dialect-specific DML wrapping. Do not append a non-portable
  `LIMIT` blindly. If deliberately select-only, narrow the documentation claim.
- Release impact: blocks stable; blocks RC if unbounded returning can be reached
  on broad updates/deletes in supported production paths.

### 3. Default prepared-resource growth

- Verdict: **Default bound fixed, but MySQL release capability and concurrent eviction defects confirmed.**
- Severity: High.
- Public invariant: native resources never exceed `preparedMaxSize`, and an
  executing statement is not released.
- Passing evidence: `prepared-default-bound.test.ts` keeps 150 default shapes at
  size 100 with 50 evictions; `{ maxSize: 10 }` does not alter the independent
  prepared limit; `{ preparedMaxSize: 7 }` remains at 7.
- Failing evidence: a MySQL-compatible client without `unprepare` retains 3
  native statements under limit 1 while Thor reports size 1. The deterministic
  `prepared-eviction-race.test.ts` releases query A's identity while A is active.
- Affected symbols: `prepareForExecution` in `execution/run-pipeline.ts`,
  `QueryCaches.preparedMaxSize`, and `makeMySQLDriver.releasePrepared`.
- Driver reached: yes.
- Root cause: MySQL always exposes `releasePrepared` even when `unprepare` is
  absent, and admission has no lease/reference count spanning driver execution.
- Recommended correction: omit release support when the client cannot unprepare,
  stop admitting at the bound, and represent prepared entries as leased states
  whose native release waits for all active executions.
- Release impact: blocks beta/RC due native resource growth and use-after-release
  risk; stable blocker.

### 4. Raw-expression columns bypass table scope

- Verdict: **Reported flat bypass already fixed; adjacent recursive mutation bypass confirmed.**
- Severity: High for wrong SQL/guard inconsistency.
- Public invariant: every structural `ColumnRef` is validated in its lexical scope.
- Passing evidence: existing/current tests cover out-of-scope and aggregation
  columns directly inside `RawExpr`; implementation traverses raw values in
  `columnRefsIn` and `unaggregatedRefsIn`.
- New failing test: `nested-scope-guards.test.ts` shows UPDATE and DELETE accept
  an invalid column inside nested `EXISTS`, execute the driver, and return success.
- Affected symbol: mutation branches of `validateQueryGuards` in
  `guards/query-guards.ts`; unlike SELECT, they do not call recursive subquery
  visitation.
- Driver reached: yes for the nested defect; no for the fixed flat case.
- Recommended correction: validate each nested mutation subquery with its own
  scope and explicit outer correlation scope. Also audit assignments and conflict
  assignments, which are not currently traversed for table scope.
- Release impact: high priority; blocks RC until nested guard behavior matches the
  public scope invariant.

### 5. Persistent destructive-migration approval

- Verdict: **Already fixed in the current working tree.**
- Severity: Critical if persistent approval returns.
- Public invariant: review approval applies to exactly one invocation.
- Evidence: CLI integration test writes legacy `reviewed: true`, proves `down`
  without `--reviewed` is blocked, proves reviewed down succeeds, then proves a
  later `redo` without a fresh flag is blocked. `status` remains read-only.
- Affected symbols: `MigrationRunOptions`, `migrationRunOptions`, and CLI
  `up`/`down`/`redo` dispatch.
- Driver reached: blocked invocations perform migration setup but do not execute
  destructive migration SQL.
- Classification: intentional safe policy. Legacy config is silently ignored;
  an upgrade diagnostic would improve ergonomics.
- Release impact: no current blocker.

### 6. Non-atomic `thor redo`

- Verdict: **Already fixed for transactional-DDL dialects in the current worktree; MySQL remains intentionally non-atomic.**
- Severity: Critical where atomicity is promised.
- Public invariant: redo is one migration operation under one lock and one
  transaction when supported.
- Evidence: current `migrator.test.ts` proves one lock/transaction and operation
  ordering. `redo-atomicity.test.ts` proves live SQLite restores both table and
  journal when reapply fails after rollback. CLI now calls `migrator.redo()`
  rather than `down(); up()`.
- Affected symbol: `makeMigrator().redo` in `migrate/migrator.ts`.
- Driver reached: yes.
- Dialects: PostgreSQL uses advisory lock plus transactional DDL; SQLite uses one
  transaction (`BEGIN IMMEDIATE` semantics); MySQL holds a named lock but DDL is
  non-transactional and partial states remain possible.
- Recommended correction: document MySQL recovery states explicitly and add live
  failure-point tests. Return one operation result/event consistently.
- Release impact: no PostgreSQL/SQLite blocker on tested behavior; MySQL partial
  recovery documentation/tests required before stable support claims.

### 7. Runtime window-frame validation mismatch

- Verdict: **Partially fixed; two residual defects confirmed.**
- Severity: Medium.
- Public invariant: runtime/cast input must obey SQL frame grammar.
- Passing evidence: invalid units, malformed boundaries, negative/fractional/
  non-finite/unsafe offsets, forged unsafe nodes, and reversed finite boundaries
  are rejected.
- Failing test: `window-frame-forgery.test.ts` accepts
  `UNBOUNDED FOLLOWING` as start, `UNBOUNDED PRECEDING` as end, and silently drops
  falsy forged frames (`null`, `false`, `0`, empty string).
- Affected symbols: `frameBetween` and `windowable.over` in
  `sql/advanced-expressions.ts`.
- Driver reached: no.
- Root cause: rank comparison permits equal invalid unbounded endpoints, and
  `spec.frame ? ... : {}` confuses absence with falsy invalid input.
- Recommended correction: reject prohibited endpoint tags explicitly and test
  `frame !== undefined` before validation.
- Release impact: medium priority; fix before RC.

### 8. Migration safety documentation mismatch

- Verdict: **Confirmed in the root README; source JSDoc and primary migration docs are correct.**
- Severity: Medium.
- Public invariant: omitted safety is unchecked, blocked by `safe-only` and
  `expand-only`, and requires a reviewed destructive-capable invocation.
- Failing test: `migration-safety-docs.test.ts` finds the README example omits
  `safety`/`phase` and then calls `m.up()` under the default policy.
- Passing evidence: `docs/migrations.md`, `docs/limitations.md`, and
  `define-migration.ts` describe omitted safety as unchecked.
- Driver reached: not applicable.
- Recommended correction: make the README example additive/expand and declare
  destructive/contract down metadata; document reviewed rollback.
- Release impact: medium documentation blocker before beta promotion messaging.

## Speculative hypotheses

| Hypothesis | Verdict | Evidence / disposition |
|---|---|---|
| A. Prepared snapshots mutable | **Confirmed, Critical.** | `prepared-snapshot-mutation.test.ts`: post-prepare raw-string mutation changes SQL to include `DROP TABLE`; parameter-name mutation makes prepared and compiled handles bind `undefined`. Driver reached for parameter cases. Stable/RC blocker. |
| B. Inline mutable values | **Resolved with construction-time snapshots.** | Direct terminals recursively snapshot arrays, plain records, and dates when values enter query IR; `parameter-encoding.test.ts` proves later source mutation is not observed. Opaque instances retain identity and should be supplied as named execution arguments when they may mutate. Compiled/prepared handles continue to reject captured inline values. |
| C. SQLite collision leak | **Confirmed, High.** | `sqlite-collision-leak.test.ts`: collision fallback, unnamed query/command, and failure paths never finalize transient statements. Driver reached. Blocks beta/stable for long-lived SQLite connections. |
| D. Prepared eviction race | **Confirmed, High.** | `prepared-eviction-race.test.ts` deterministically records release of an active prepared name. Blocks beta/stable. |
| E. Cache collision/dialect leakage | **Wrong-SQL collision reuse disproved for current adapters.** | Registry compares name and SQL and falls back unnamed. SQLite fallback leaks (C). Mutable custom dialect objects can still make identity-keyed direct compile caches stale; not executed here. |
| F. Duplicate named params | **Intentional strict contract.** | Distinct same-name declarations reject before driver; same-node reuse is the intended form. Existing tests cover duplicate/conflict rejection. Equivalent-schema ergonomics remain a design choice, not a correctness defect. |
| G. Relation parameter limits | **Partially confirmed by implementation audit; live boundary not executed.** | Hard-coded budget 800 chunks ordinary keys, but a composite key wider than 800 exceeds the stated budget and the limit is not dialect-aware. Add 800/801 and live backend tests. |
| H. Recursive scope validation | **Confirmed, High.** | Mutation `EXISTS` bypass in `nested-scope-guards.test.ts`; driver is invoked. Name-only source identity also makes alias shadowing ambiguous. |
| I. Observability secrets | **Disproved for tested default paths.** | Defaults omit SQL/params, redacted mode does not emit values, and failure tags are sanitized by existing tests. Literal-derived `queryHash` dictionary leakage and migration credential text were not exhaustively tested. |
| J. Transaction cleanup races | **Mostly disproved by implementation and existing tests.** | Uninterruptible rollback, body+rollback cause preservation, interruption cleanup, savepoints, and retries are covered. SAVEPOINT/release and exact commit-interruption races remain untested. |
| K. Journal upgrade races | **Confirmed by implementation audit, not live-reproduced.** | `status()` and `dryRun()` can run MySQL checksum-column upgrade without the migration lock, so concurrent readers may both issue ALTER. Add a barrier-controlled live MySQL test. |
| L. Generated migration source forgery | **Confirmed, High or contract-ambiguous.** | `migration-statement-authenticity.test.ts`: plain and even non-string `{ _tag: "SqlStatement" }` objects pass `isSqlStatement`. CLI generation intentionally emits this shape. Decide whether migration source is author-trusted; at minimum validate `sql` as string. |
| M. Identifier edge cases | **Partial/ambiguous.** | Delimiter escaping has deterministic property coverage. Empty, NUL, overlength UTF-8, backend truncation collisions, and qualification semantics are not rejected consistently and were not live-tested here. |
| N. Normalization semantics | **Existing immutable-input properties pass; mutable-input assumption is false.** | Existing deterministic/idempotence properties pass. Hypothesis A proves identity-cached mutable leaves can change SQL or bindings after normalization/preparation. |
| O. Package duplication | **Ambiguous and unexecuted.** | Module-private `WeakSet` prevents forgery but rejects genuine unsafe nodes from a second physical Thor copy. A packed two-alias fixture is required to define and test the supported model. |

## Confirmed defects

1. Prepared/compiled snapshots are mutable, including post-prepare raw SQL text
   injection and parameter binding corruption.
2. DML returning cardinality probes materialize all returned rows in every mode.
3. Prepared eviction can release an in-flight statement.
4. MySQL clients without `unprepare` can exceed the native resource bound while
   Thor metrics report the configured bound.
5. SQLite collision and unnamed statements are not finalized.
6. Mutation nested subqueries bypass recursive table-scope validation.
7. Window frames accept invalid unbounded endpoints and silently discard falsy
   forged frames.
8. Plain/malformed objects impersonate migration `SqlStatement` values.
9. The README migration example contradicts runtime safety policy.

## Disproved findings

- Ordinary object and JSON forgery of `UnsafeSqlNode` no longer works in one
  package identity.
- Current prepared collision guards do not reuse different SQL under one name.
- Default observability paths do not expose raw parameter values in existing
  tests.
- Distinct duplicate named parameters are deliberately rejected before I/O.

## Already-fixed findings

- Flat structural columns inside raw expressions are visible to table and
  aggregation guards.
- Default prepared admission is finite (100 per physical connection).
- CLI destructive review is invocation-scoped.
- Redo is one service operation and is atomic on tested SQLite failure behavior.
- Most window boundary shape and offset validation is present.
- Primary migration docs and source JSDoc describe omitted safety correctly.

## Ambiguous contracts

- Inline mutable-value snapshot timing.
- Cross-copy Thor value interoperability.
- Whether authored/generated `SqlStatement` is intentionally trusted source or
  must have constructor identity.
- Backend identifier validity and schema-qualified name representation.
- Whether DML cardinality is intentionally less bounded than SELECT; current
  remediation claims do not make that distinction.

## Areas not tested

- Live PostgreSQL `pg_prepared_statements` growth/reuse and MySQL server prepared
  counters under thousands of shapes.
- Heap growth and pooled physical-connection reacquisition.
- Live PostgreSQL redo races and live MySQL redo partial-failure recovery points.
- Concurrent MySQL legacy-journal upgrade.
- Two installed Thor package copies/versions.
- Relation batches at backend parameter, expression-depth, and packet limits.
- Full identifier matrix against all three live dialects.
- Environment-variable review, missing TTY, and generated-plan CLI application;
  the current CLI exposes only the invocation flag for up/down/redo.
- More exhaustive secret probes for driver-provided error messages and migration SQL.
- Bun-specific transient statement finalization instrumentation.

## Test execution matrix

| Test category | Node | Bun | SQLite | PostgreSQL | MySQL |
|---|---|---|---|---|---|
| Unit | Executed: adversarial failures confirmed | Runtime contract only | Executed: pass and fail findings | Compiler/fake plus baseline | Compiler/fake plus baseline |
| Property | Executed and passed (seeded) | Not separately executed | Dialect-neutral | Dialect-neutral | Dialect-neutral |
| Concurrency | Executed and failed (prepared race) | Not executed | Redo failure atomicity passed | Fake lock test passed; live race not executed | Live race not executed |
| Live integration | Node SQLite executed | Bun SQLite 68 passed | Node 13 passed; Bun 68 passed | Docker 147-suite lane passed | Docker 147-suite lane passed |
| CLI | SQLite subprocess lifecycle passed | Not executed | Executed and passed | Not executed | Not executed |

## Reproduction commands

```sh
pnpm exec vitest run packages/thor/test/prepared-snapshot-mutation.test.ts
pnpm exec vitest run packages/thor/test/returning-cardinality.test.ts
pnpm exec vitest run packages/thor/test/prepared-eviction-race.test.ts
pnpm exec vitest run packages/thor/test/prepared-default-bound.test.ts
pnpm exec vitest run packages/thor/test/sqlite-collision-leak.test.ts
pnpm exec vitest run packages/thor/test/nested-scope-guards.test.ts
pnpm exec vitest run packages/thor/test/window-frame-forgery.test.ts
pnpm exec vitest run packages/thor/test/migration-statement-authenticity.test.ts
pnpm exec vitest run packages/thor/test/migration-safety-docs.test.ts
```

Positive/disproof evidence:

```sh
pnpm exec vitest run packages/thor/test/unsafe-sql-authenticity.test.ts packages/thor/test/property-security-invariants.test.ts
pnpm exec vitest run packages/cli/test/cli.test.ts -t "requires a fresh reviewed acknowledgement"
pnpm exec vitest run packages/thor/test/redo-atomicity.test.ts
```

## Prioritized findings

### Release blockers

1. Prepared snapshots permit post-construction SQL mutation and parameter binding
   corruption. This can execute SQL different from the prepared handle's authored
   shape and is a stable-release blocker.
2. Prepared eviction releases active identities. Real SQLite/MySQL adapters may
   finalize/unprepare resources in use.
3. Native MySQL resources can grow beyond the configured bound when release is
   unavailable while Thor reports bounded state.
4. DML returning can materialize arbitrarily large results despite the broad
   cardinality-remediation claim.

### High priority

1. SQLite transient statement leaks.
2. Recursive mutation scope guard bypass.
3. Structural `SqlStatement` acceptance until its author-trust contract is made
   explicit and malformed values are rejected.
4. Unlocked MySQL journal upgrade race (implementation-confirmed, reproduction pending).

### Medium priority

1. Window frame grammar gaps.
2. README migration-safety drift.
3. Inline mutable-value semantics and identifier policy.

### Deferred or disproved

- Same-package `UnsafeSqlNode` forgery is prevented by a private registry.
- Persistent reviewed config no longer authorizes later commands.
- SQLite redo failure is atomic in the live test; PostgreSQL uses the same
  one-lock/one-transaction service design.
- Cache-name collisions fall back instead of executing stale SQL, though the
  SQLite fallback currently leaks.
