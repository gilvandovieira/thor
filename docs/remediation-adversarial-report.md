# Adversarial remediation final report

Date: 2026-07-11

Scope: reconciliation of the defects discovered in
[adversarial-test-audit.md](./adversarial-test-audit.md) against the current
working tree. This is a documentation and implementation-evidence report, not a
new release certification. Thor remains **`0.1.0-alpha.1` (alpha)**.

## Completed remediation

| Area | Current behavior | Existing focused evidence |
|---|---|---|
| DML returning bounds | `RETURNING.one()` and `.maybeOne()` pass `maxRows: 2` to every driver path; at most two returned rows are materialized/decoded. The mutation itself is not rolled back automatically. | `returning-cardinality.test.ts`; driver implementations and `FakeDriver` honor `maxRows` |
| Immutable prepared snapshots | Compiled/prepared plans deep-copy and freeze query records, collections, raw-template strings, parameter nodes, nested queries, and selections before normalization. | `prepared-snapshot-mutation.test.ts` |
| Lease-safe prepared resources | Prepared entries hold a lease for the complete driver Effect. Active entries are not evicted; a new shape runs unprepared when no idle releasable entry exists. | `prepared-eviction-race.test.ts` |
| MySQL without `unprepare` | The adapter does not expose `releasePrepared`; admission stops at `preparedMaxSize` and later shapes run through the unprepared query path. | `prepared-default-bound.test.ts`, `mysql.test.ts` |
| SQLite transient cleanup | Unnamed and collision-fallback statements are transient and finalize in `finally` on success or failure when `finalize`/`Symbol.dispose` exists. | `sqlite-collision-leak.test.ts`, `sqlite.test.ts` |
| Recursive mutation scopes | Nested subqueries in update/delete predicates are recursively validated and out-of-scope columns fail before driver I/O. | `nested-scope-guards.test.ts` |
| Authenticated migrations | `SqlStatement` values are frozen and registered by `sql`/`sqlStatement`; structural lookalikes and malformed payloads fail authenticity checks. | `migration-statement-authenticity.test.ts` |
| Package-copy isolation | Authenticity registries are intentionally package-local. The CLI validates string SQL from trusted loaded migration source and reconstructs a local authenticated statement; arbitrary cross-copy runtime values remain isolated. | CLI `localizeMigration` path and CLI migration-loading tests; no claim of general cross-copy interoperability |
| Inline construction snapshots | Arrays, plain records, and dates captured inline are recursively copied/frozen when entering query IR. Opaque instances retain identity by policy. | `parameter-encoding.test.ts` |
| Window-frame runtime checks | Prohibited unbounded endpoints and falsy forged frames are rejected rather than accepted or silently omitted. | `window-frame-forgery.test.ts` |
| README migration safety | The root example declares forward/down safety and phase metadata consistently with the default policy. | `migration-safety-docs.test.ts` |

These are focused regression-test references. They do not imply that those tests,
the full unit suite, Bun lanes, or live database lanes were executed during this
documentation reconciliation.

## Current policy decisions

### Identifiers

The current alpha policy guarantees dialect delimiter escaping for opaque single
identifiers. It does not claim backend-validity or portability validation for
empty, NUL, overlength, reserved, truncation-colliding, or dotted names. Ordinary
table/column strings are not parsed as qualified names. This is documented as a
limitation rather than represented as completed validation work.

### Relation batch budget

The batched relation strategy targets 800 bound key values and computes batch
size as `floor(800 / keyColumnCount)`, minimum one. Composite keys wider than 800
columns therefore exceed the target for one key. The budget is not dialect-aware
and is not a guarantee against backend parameter, expression-depth, or packet
limits.

### Package copies

Package-local authenticity is a security boundary, not cross-version value
interoperability. The CLI's migration-source localization is a narrow trusted
source adapter. Query/migration branded values from arbitrary duplicate package
copies are not promised to work across copies.

## Unimplemented high-value areas

| Area | Why it remains valuable | Honest current status |
|---|---|---|
| Streaming/cursors | Bounds memory for genuinely large reads and requires interruption-safe cursor ownership. | No `.stream()` terminal or scoped cursor driver contract. |
| Broad migration generation | Reduces hand-authored alteration risk. | Generation remains create-table-only; alteration, rename, index/constraint, enum/view, identity/generated-column, and routine diffs are not generated. |
| Routine completeness | Needed for advanced stored-program APIs. | Named/default/overloaded/OUT arguments, procedure output decoding, extension verification, and routine introspection remain partial/deferred. |
| Dialect-aware relation limits | Avoids backend-specific failures on large/composite relation loads. | Fixed conservative 800-value target; no dialect-derived budget or 800/801 live boundary matrix. |
| Identifier validation policy | Prevents backend truncation collisions and invalid catalog names before I/O. | Quoting is tested; backend validity/length/qualification semantics are not normalized or live-matrix tested. |
| General duplicate-package interoperability | Could support plugin graphs carrying Thor values across versions/copies. | Deliberately unsupported outside CLI migration localization; no two-alias packed fixture certifies interoperability. |
| Live prepared-resource stress | Would verify real server/client counts, pool reacquisition, and long-run heap behavior. | Focused fake/structural tests exist; no claim here of thousands-of-shapes live PostgreSQL/MySQL or heap testing. |
| MySQL journal-upgrade concurrency | Could expose simultaneous legacy-column upgrade races. | Barrier-controlled live MySQL reproduction/remediation is not established by this report. |
| Live redo failure matrices | Important for recovery documentation, especially non-transactional MySQL DDL. | SQLite atomic failure behavior has focused coverage; PostgreSQL race and MySQL partial-failure points are not certified here. |
| Remaining cleanup races | Commit/savepoint interruption timing can be driver-sensitive. | Existing transaction cleanup tests are substantial, but exact SAVEPOINT/release and commit-interruption race matrices remain incomplete. |
| Secret leakage depth | Driver messages and migration SQL can carry sensitive text. | Default query observability is redacted; exhaustive driver-error and migration-text probes remain incomplete. |

## Verification for this reconciliation

Only commands actually run after these documentation edits belong here:

| Command | Result |
|---|---|
| `pnpm docs:check` | Passed: documentation/API audits, 11 README syntax checks plus 1 executable query, generated capabilities, and 10 installable skills current |

No live PostgreSQL, MySQL, Node SQLite, Bun SQLite, package-consumer, unit,
property, coverage, quality, or benchmark command is claimed as run by this
reconciliation. Historical reports retain their own dated execution records.
