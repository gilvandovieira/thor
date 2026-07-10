# JSONL ETL example

A self-contained, semi-advanced Thor project that generates a deterministic
15,000-line JSONL file, validates and transforms it with Effect Schema, loads it
into SQLite, builds daily aggregates, and runs analytical queries.

## Run

From the repository root:

```sh
pnpm install
pnpm build
pnpm example:jsonl-etl
```

The first run creates `data/events.jsonl` and `data/etl.sqlite`. Later runs are
idempotent: 3,000 duplicate event IDs exercise `ON CONFLICT DO UPDATE`, migration
journal state is reused, and aggregate rows are refreshed. Reset everything with:

```sh
pnpm --filter @thor-examples/jsonl-etl run clean
```

## Feature map

The executable SQLite path demonstrates:

- SQLite schema authoring with defaults, JSON codecs, indexes, checks, unique
  constraints, and foreign keys;
- schema-derived `Select`/`Insert` types and Effect Schema JSONL validation;
- generated migration operations, policy checks, journal status, and drift;
- Effect resource acquisition/release for `DatabaseSync`;
- insert/update/delete/returning, conflict upserts, named parameters, stable
  compiled handles, named prepared queries, and cardinality refinements;
- bounded query caches, safe/trusted execution mode, structured observability,
  tracing, metrics, redacted parameter logs, and cache statistics;
- batched transactions and prepared statement reuse;
- joins, aggregates, grouping/having, ordering/limits, CTEs, windows, correlated
  `EXISTS`, set operations, and a structural raw SQL JSON predicate.

`feature-tour.ts` covers features that SQLite cannot execute by compiling them
against their supported dialect: PostgreSQL lateral joins/scalar and table
functions, MySQL duplicate-key upserts/procedures, capability inspection, query
inspection, and expand-contract migration planning. Thor deliberately rejects
stored routines and lateral joins on SQLite before driver I/O.

This is broad feature coverage rather than a production ETL architecture. The
example reads the generated medium-size file into memory for clarity; a real
unbounded feed should place a streaming parser ahead of the same bounded batch
transaction boundary.
