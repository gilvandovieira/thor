---
name: thor-debugging
description: "Debug from IR to capabilities to SQL to execution."
---

# Thor Skill: Debugging

## Goal

Teach an agent to debug in pipeline order — IR → capabilities → SQL → execution → decode — instead of rewriting raw SQL.

## Use When

- A query fails to compile, decode, guard, or migrate, or produces unexpected SQL.

## Required Checks

- Read `query.inspect()` for kind/tables/params/cardinality/capabilities.
- Read the tagged error: `CapabilityError`, `CompileError`, `DecodeError`, `MigrationError`.
- Inspect generated SQL with `.toSql(dialect)`.
- Check required vs supported capabilities before assuming a compiler bug.
- Use `thor doctor` for connectivity/journal/pending/drift/capabilities.

## Safe Patterns

- `query.inspect()` and `query.requiredCapabilities()` first.
- Compare `.toSql()` output across dialects to localize a difference.

## Unsafe Patterns

- Jumping straight to hand-written SQL rewrites.
- Suppressing a tagged error instead of reading its fields.
- Assuming a decode error is a driver bug (check the codec).

## Examples

```ts
console.log(query.inspect())            // shape metadata
console.log(query.toSql(PostgresDialect).sql)
```

## Verification

- Reproduce with `FakeDriver` returning the offending row.
- Add a regression test at the failing layer.
- Confirm the fix keeps SQL snapshots stable.

## Hard Rule

Debug from IR → capabilities → SQL → execution → decode. Do not jump straight to raw SQL rewrites.
