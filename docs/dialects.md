# Dialect support

Thor validates dialects through one capability-aware contract and SQL feature
matrix. A capability is reported as `native`, `emulated`, `unsupported`, or
`unknown`; unsupported and unknown query features fail conservatively before
driver execution.

Run the same authoritative matrix from the CLI:

```sh
thor capabilities postgres
thor capabilities sqlite
thor capabilities mysql
```

## Targets

| Dialect | v1 target | Live lanes | Support boundary |
|---|---|---|---|
| PostgreSQL | Production | node-postgres, postgres.js | Primary target; every implemented public query feature runs through the full shared matrix |
| SQLite | Production/local/embedded | node:sqlite, bun:sqlite | Node and Bun run the same real contract and feature fixtures; unsupported routines and lateral joins fail through capabilities |
| MySQL 8 | Compatibility, explicitly partial | mysql2 | Core DML, joins, CTEs, windows, sets, duplicate-key upsert, transactions, and decoding are live-tested; scalar/procedure routine compilation has unit/fake coverage but is not in the MySQL live routine matrix; DML RETURNING, full join, arrays, PostgreSQL conflict syntax, table-valued routines, streaming, and transactional DDL are unsupported |

MySQL remains partial because some PostgreSQL/SQLite features have no MySQL
equivalent and MySQL DDL is not transactionally rollback-safe. The matrix is the
source of truth; documentation should not infer support from database syntax
alone.

For postgres.js, structural wrappers should expose `unsafe` and the client's
`CLOSE` token. Thor uses `unsafe(...).cursor(2, ...)` for bounded DML
`RETURNING.one()`/`.maybeOne()` probes; wrappers without cursor/`CLOSE` support
fail that terminal instead of materializing rows. node-postgres uses its query
row bound for the same contract.

Bun 1.3 `bun:sqlite` exposes explicit statement finalization and an iterable row
path in the tested runtime. Thor stops bounded probes after two rows and
finalizes transient/collision statements deterministically. Structural SQLite
clients without an iterator reject bounded DML probes rather than pretending an
`.all().slice(2)` path is bounded.

## Isolation rule

Shared query IR and guards contain logical operations and capability bits, not
backend identifiers. Identifier quoting, placeholders, candidate-row syntax,
transaction starts, query compilation, migration compilation, and driver
behavior belong to the selected dialect adapter. An architecture test prevents
new dialect imports or dialect-id branches from entering the shared IR, guards,
compiler, or transaction executor.
