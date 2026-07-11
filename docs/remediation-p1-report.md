# Priority 1 remediation verification report

Scope: the independent-review Priority 1 findings (P1.1–P1.5), verified against
the `remediation/p0-correctness` working tree on 2026-07-10. This report records
the initial behavior, decision, correction, executable evidence, and remaining
limits. It does not claim that Priority 0 or Priority 2–4 are complete.

## Initial baseline

| Gate | Initial result |
|---|---|
| `pnpm install --frozen-lockfile` | executed, passed |
| `pnpm build` / `pnpm typecheck` / `pnpm test:types` | executed, passed |
| `pnpm test` | executed: 807 passed, 147 skipped (live E2E files) |
| `pnpm test:coverage` | executed, passed; 88.82% statements, 80.04% branches, 88.45% functions, 90.67% lines |
| `pnpm test:property` | executed, 8 passed |
| `pnpm docs:check` | failed initially: missing `@returns` on `assertPaginationValue` from preceding P0 work |
| `pnpm quality:check` | executed, passed (the then-current narrow Biome set plus Knip) |
| `pnpm test:packages` | executed, Node packed consumer passed |
| `pnpm test:runtime:node` | executed, 13 SQLite contract tests passed |
| `pnpm test:runtime:bun` | executed, 68 Bun SQLite/feature tests passed |
| `pnpm e2e` | executed with Docker PostgreSQL/MySQL, 147 tests passed; not skipped |
| `pnpm bench:gate:node` | failed: `point.warm` 13.2 µs vs 4.39 µs baseline (3.01×) |
| `pnpm bench:gate:bun` | failed: `point.warm` 10.1 µs vs 3.66 µs baseline (2.78×) |

The two benchmark failures are baseline facts, not introduced successes or
skipped lanes. A concurrent P0 commit subsequently added cardinality-probe IR
memoization; final validation records the post-remediation result separately.

## P1.1 — pool-layer semantics

**Status: confirmed and reframed using the review's allowed alternative.**

- Relevant code: `PostgresPoolLayer` in `postgres/driver.ts` and
  `MySQLPoolLayer` in `mysql/driver.ts` each acquired one connection and retained
  it for the complete Layer scope.
- Reproduction: two reads of the provided `Database` service used the same
  driver; pool acquisition happened only once. This is correct for transaction
  affinity but is not per-operation pooling.
- Root cause: API naming implied pool-wide query concurrency while implementation
  deliberately provided a dedicated affinity connection.
- Correction: replaced the misleading names with
  `PostgresDedicatedPoolConnectionLayer` and
  `MySQLDedicatedPoolConnectionLayer`. Their JSDoc explicitly says all normal
  queries and nested transactions share one physical connection for the layer
  lifetime.
- Tests: `scoped-layers.test.ts` covers acquisition failure/pool exhaustion,
  interruption, release failure, one acquisition/release per layer, and owned
  prepared cleanup. Existing `transaction.test.ts` continues to cover nested
  same-driver savepoint affinity and cleanup failures.
- Documentation: v1 spec §11.6, roadmap, limitations, and Effect-execution skill.
- Residual limitation: Thor does not yet ship an application-wide per-operation
  pool service. Applications needing multiple concurrent physical connections
  must create/provide separate scoped layer instances. The API no longer claims
  otherwise.

## P1.2 — bounded prepared resources

**Status: confirmed and corrected.**

- Relevant code: the old per-driver `preparedByDriver: WeakMap<object, Set>` in
  `execution/run-pipeline.ts`; `QueryCaches.preparedNames`; SQLite's permanent
  statement `Map`; mysql2 `execute()`'s connection cache.
- Reproduction: a bounded `QueryCaches({ maxSize: 2 })` evicted observation keys
  while the driver-level Set/SQLite Map kept every distinct prepared shape.
- Root cause: the `prepared` cache was an observation registry, not a lifecycle;
  the driver contract had no release/clear seam.
- Correction: optional `Driver.releasePrepared` and `Driver.clearPrepared`
  lifecycle hooks; connection-scoped LRU admission in `prepareForExecution`;
  SQLite finalization through `finalize`/`Symbol.dispose` where exposed; mysql2
  `unprepare(sql)`; scoped SQLite/MySQL cleanup before connection release. Drivers
  without a safe public deallocate/recreate contract stop admitting new shapes at
  the configured bound and execute them unprepared.
- Collision behavior: the connection registry compares both name and SQL. A
  name collision is executed unprepared and never reuses the wrong statement.
- Tests: `query-cache.test.ts` proves actual resources remain at the configured
  bound and LRU eviction calls release; `sqlite.test.ts` proves finalization and
  collision safety; `mysql.test.ts` proves release/clear; `scoped-layers.test.ts`
  proves cleanup precedes owned connection release. Per-driver WeakMap keys keep
  registries independent across physical connections.
- Documentation: query-cache guide, v1 spec §9.5, limitations.
- Residual limitation: Node's supported `node:sqlite` `StatementSync` API does
  not expose an explicit finalizer, so the database close remains the ultimate
  release boundary there. Compatible runtimes that expose `finalize` or
  `Symbol.dispose` are finalized on eviction.

## P1.3 — MySQL prepared execution

**Status: confirmed and corrected.**

- Relevant symbol: `makeMySQLDriver` in `mysql/driver.ts`.
- Reproduction: when `preparedStatements: false` removed the prepared name,
  parameterized calls still selected `client.execute()` because the old branch
  tested `prepared || params.length > 0`.
- Root cause: the generic setting controlled identity at the execution layer but
  the adapter independently treated every parameterized call as prepared.
- Correction: enabled named parameterized execution uses mysql2 `execute`; disabled
  parameterized execution uses `query(sql, encodedValues)`; parameter-free SQL
  uses `query(sql)`.
- Tests: `mysql.test.ts` asserts enabled, disabled, parameter-free, repeated reuse,
  value normalization, and lifecycle call paths; generic prepared tests assert
  the Database option selects/omits an identity.
- Documentation: v1 spec §11.6 and limitations now match mysql2 semantics.
- Residual limitation: mysql2 itself may maintain other internal caches outside
  Thor's structural client contract; Thor explicitly manages the automatic
  `execute()` statement cache it invokes.

## P1.4 — migration checksums

**Status: confirmed and corrected.**

- Relevant symbols: `hashText`, `checksum`, and journal validation in
  `migrate/define-migration.ts` / `migrate/migrator.ts`.
- Reproduction: new entries were eight-character FNV-1a hashes. Material included
  up/down/revision but omitted ID, name, irreversible, safety, and phase metadata.
- Root cause: a fast structural hash was reused as an integrity fingerprint.
- Correction: canonical UTF-8 material hashed as `sha256:v1:<64 hex>`; fields
  include ID, name, up/down kind and representation, revision, irreversible,
  safety, and phase. Generated plan journal entries use the same algorithm family.
  `hashText` remains only for the advisory-lock integer and legacy verification.
- Compatibility: matching legacy eight-character FNV rows are accepted without
  journal rewrite. Unknown versioned algorithms fail with tagged `MigrationError`.
- Tests: `migrate.test.ts` covers determinism, all metadata, both SQL directions,
  Effect revision, long/Unicode content, legacy status, and unknown algorithms;
  `migrator.test.ts` covers journal compatibility/no rewrite and clear failure;
  live migrator E2E asserts the new format.
- Documentation: migration guide checksum section, v1 spec §15.6, limitations.
- Residual limitation: legacy hashes retain their historical collision weakness;
  they are read-only compatibility records. Reapplying or silently rewriting
  migration history would be more dangerous, so upgrades happen through new rows.

## P1.5 — unsafe SQL boundaries

**Status: partially valid across the audit and corrected for confirmed public paths.**

- Already fixed: raw query/migration template interpolation retained structural
  params/columns and required `unsafeSql` for dynamic text; declared query routine
  names were validated/quoted; migration identifiers were dialect-quoted.
- Confirmed gaps: `WindowSpec.frame`, `Column.defaultSql`,
  `Column.generatedAlwaysAs`, table check expressions, and routine DDL type,
  language, return, and body fields accepted plain strings as SQL syntax.
- Correction: structured window-frame constructors (`rowsBetween`,
  `rangeBetween`, `groupsBetween`, validated boundaries); custom frames accept
  only `unsafeSql`. SQL defaults, generated/check expressions, and routine DDL
  syntax also require the explicit unsafe node. Runtime tag checks reject casts
  that bypass TypeScript.
- Tests: cross-dialect structured/custom window SQL and invalid-frame tests in
  `advanced-query.test.ts`; runtime injection/cast tests in `schema.test.ts`;
  routine DDL compiler tests; compile-time negative cases in
  `parameters.types.ts`; existing raw-SQL injection tests remain.
- Documentation: limitations, migration guide, v1 spec safety text, generated
  safety/migration skills, and the JSONL example.
- Residual limitation: `MigrationOperation.RawSql` remains a deliberately explicit
  internal operation (`_tag: "RawSql"`, `unchecked: true`) because planners need
  to represent reviewed opaque operations. It is policy-classified as contract/
  unchecked and is not an ordinary value interpolation path.

## Post-remediation validation

| Gate | Result |
|---|---|
| install/build/typecheck/type tests | executed, passed |
| unit tests | 45 files passed; 831 tests passed; 147 live-E2E tests skipped in this command and executed separately below |
| coverage | passed: 89.01% statements, 80.41% branches, 88.61% functions, 90.62% lines |
| property tests | 8 passed |
| documentation/API/examples/generated skills | passed |
| quality | passed (configured Biome files plus Knip) |
| packed consumers | Node passed through `pnpm test:packages`; additional `node scripts/test-packages.mjs --bun` passed Node + Bun and imported every declared export |
| Node SQLite runtime | 13 passed |
| Bun SQLite runtime | 68 passed |
| PostgreSQL/MySQL E2E | Docker services available; 147/147 tests executed and passed |
| Node performance gate | passed against committed baseline; warm path 4.87 µs (still above the 2 µs aspirational target) |
| Bun performance gate | passed against committed baseline; warm path 3.53 µs (still above the 2 µs aspirational target) |

No database lane in the E2E result was reported as passed through a skip. The
ordinary unit command's 147 skipped tests are exactly the environment-gated live
files that the separate Docker E2E command executed.
