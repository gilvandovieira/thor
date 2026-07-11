# JSONL ETL example

A self-contained, semi-advanced Thor project that generates a deterministic
15,000-line JSONL file, validates and transforms it with Effect Schema, loads it
into SQLite, atomically reconciles daily aggregates, and runs analytical queries.

## Run

From the repository root:

```sh
pnpm install
pnpm example:jsonl-etl
```

The first run creates `data/events.jsonl` and `data/etl.sqlite`. Later runs are
idempotent: 3,000 duplicate event IDs exercise `ON CONFLICT DO UPDATE`, checked
migration definitions validate journal order/checksums, and aggregate rows are
fully reconciled in one transaction. Reset everything with:

```sh
pnpm --filter @thor-examples/jsonl-etl run clean
```

The migration model changed with this example revision. Run the clean command
once if `data/etl.sqlite` was created by an older checkout; current databases are
then checksum-validated and safely reusable across reruns.

## Feature map

The executable SQLite path demonstrates:

- SQLite schema authoring with defaults, JSON codecs, indexes, checks, unique
  constraints, and foreign keys;
- schema-derived `Select`/`Insert` types and Effect Schema JSONL validation;
- generated migration SQL wrapped in checked migration definitions, journal
  order/checksum validation, and structural introspection drift;
- leak-safe `SQLiteScopedLayer` ownership for `DatabaseSync`;
- insert/update/delete/returning, conflict upserts, named parameters, stable
  compiled handles, prepared statement reuse, and cardinality refinements;
- bounded query caches, safe-by-default execution, structured observability,
  tracing, metrics, redacted parameter logs, and cache statistics;
- batched transactions, failed-run finalization, and prepared statement reuse;
- joins, aggregates, grouping/having, ordering/limits, CTEs, windows, correlated
  `EXISTS`, set operations, and a structural raw SQL JSON predicate.

`feature-tour.ts` covers features that SQLite cannot execute by compiling them
against their supported dialect: PostgreSQL lateral joins/scalar and table
functions, MySQL duplicate-key upserts/procedures, capability inspection, query
inspection, and expand-contract migration planning. The tour executes compile-time
checks proving Thor rejects stored routines and lateral joins on SQLite before
driver I/O. Runtime detection and query inspection are labeled experimental and
used only as advisory diagnostics; executable hot paths use stable `CompiledQuery` handles.

This is broad feature coverage rather than a production ETL architecture. The
example reads the generated medium-size file into memory for clarity. A real
unbounded feed should place a streaming parser ahead of the same bounded batch
transaction boundary and use versioned, reviewed migration files.

For disposable smoke runs, paths and fixture size can be overridden:

```sh
THOR_ETL_INPUT=/tmp/thor-events.jsonl \
THOR_ETL_DATABASE=/tmp/thor-etl.sqlite \
THOR_ETL_ROWS=500 \
pnpm example:jsonl-etl
```
