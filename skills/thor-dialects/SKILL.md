---
name: thor-dialects
description: "Keep dialect-specific behavior in dialect adapters."
---

# Thor Skill: Dialects

## Goal

Teach an agent to keep the shared core dialect-neutral and route backend differences through PostgreSQL/SQLite/MySQL adapters.

## Use When

- The user targets a specific backend or hits a dialect difference in SQL, migrations, or routines.

## Required Checks

- The IR, guards, and cache keys are dialect-neutral; only the compiler renders SQL.
- Placeholders, quoting, comparison, and capability matrices differ per dialect.
- MySQL is an explicitly partial target (no `RETURNING`, non-transactional DDL).
- SQLite type affinity collapses logical types; introspection type-diff is lossy.
- Compile against a dialect without executing via `.toSql(dialect)`.

## Safe Patterns

- Add backend behavior in the dialect adapter, not the core.
- Use `withMode`/layers to switch backends without changing the query.

## Unsafe Patterns

- Writing Postgres-shaped assumptions into core abstractions.
- Assuming MySQL supports `RETURNING` or transactional DDL.
- Comparing raw SQLite column types for drift.

## Examples

```ts
db.select({ body: notes.body }).from(notes).toSql(SQLiteDialect)
```

## Verification

- Run the identical contract suite across all dialects.
- Snapshot per-dialect SQL and migration DDL.
- Assert `dialect-isolation` (no leakage into IR/guards).

## Hard Rule

Do not write Postgres-shaped core abstractions. Dialect-specific behavior belongs in dialect adapters.
