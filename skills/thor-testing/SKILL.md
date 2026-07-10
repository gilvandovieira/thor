---
name: thor-testing
description: "Test Thor features at the correct layer."
---

# Thor Skill: Testing

## Goal

Teach an agent to test each feature at the right layer — types, IR, guards, SQL snapshots, fake-driver execution, and integration.

## Use When

- The user adds or changes a query, schema, migration, dialect, or routine feature.

## Required Checks

- Add type tests for inferred row/param shapes.
- Add SQL snapshot tests per dialect via `.toSql(dialect)`.
- Use `FakeDriver`/`FakeDatabaseLayer` for zero-I/O execution and error paths.
- Run the capability-aware dialect contract suite for adapters.
- Add migration concurrency/failure tests where relevant.

## Safe Patterns

- `FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [...] }))`
- `makeDialectContractSuite(...)` for every dialect adapter.
- Property tests with a deterministic `fast-check` seed.

## Unsafe Patterns

- Relying only on live integration tests.
- Skipping the capability-error branch for unsupported features.
- Non-deterministic fuzz seeds.

## Examples

```ts
const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] })
await Effect.runPromise(Effect.provide(query.all(), FakeDatabaseLayer(driver)))
```

## Verification

- Ensure unit + fake-execution + integration coverage for new features.
- Assert typed errors, not thrown exceptions.
- Keep SQL snapshots current across dialects.

## Hard Rule

Every new feature needs tests at the correct layer. Do not rely only on integration tests.
