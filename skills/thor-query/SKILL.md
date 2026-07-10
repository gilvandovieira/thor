---
name: thor-query
description: "Write Thor fluent SQL queries safely."
---

# Thor Skill: Writing Queries

## Goal

Teach an agent to build Thor fluent queries that stay pure until execution and never interpolate user input into SQL.

## Use When

- The user asks for queries, repository functions, filtering, joins, sorting, pagination, or mutations.

## Required Checks

- Use schema-defined tables and columns; do not reference tables outside query scope.
- Use `param(name, Schema)` for every user-supplied value.
- Check dialect capability before advanced SQL (joins/CTE/window/upsert).
- Use `.one()` only when exactly one row is expected; `.maybeOne()` when absence is valid; `.all()` for many; `.run()` for writes.
- Compile a hot path with `.compile()`; bind values at `execute()` time.

## Safe Patterns

- `db.select({ id: users.id }).from(users).where(eq(users.email, param("email", Schema.String)))`
- `db.insert(users).values({ email }).returning({ id: users.id }).one()`
- For trusted dynamic text, `unsafeSql(...)` marks the boundary explicitly.

## Unsafe Patterns

- String-concatenating user input into SQL or `unsafeSql`.
- Using `.one()` where zero or many rows are possible.
- Referencing a column from a table not in `from`/`join` scope.

## Examples

```ts
const FindByEmail = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .one()
  .compile()

const user = yield* FindByEmail.execute({ email })
```

## Verification

- Add type tests for the row shape.
- Add per-dialect SQL snapshot tests.
- Add integration tests when behavior depends on the dialect.

## Hard Rule

Never interpolate user input into raw SQL. Use params and schema-backed values.
