---
name: thor-effect-execution
description: "Run Thor queries as Effects with layers and transactions."
---

# Thor Skill: Executing with Effect

## Goal

Teach an agent that building a query is pure and only terminal methods produce an Effect requiring the `Database` service.

## Use When

- The user runs queries, wires a database layer, uses transactions, or handles typed errors.

## Required Checks

- Terminal methods `all`/`one`/`maybeOne`/`run` return Effects requiring `Database`.
- Thor does not currently ship `.stream()`; do not describe `.all()` as streaming.
- Provide a `Database` via a Layer (`PostgresLayer`/`SQLiteLayer`/`MySQLLayer`/`FakeDatabaseLayer`).
- Wrap related writes in `db.transaction(...)`; nested calls use savepoints.
- Handle tagged errors with `Effect.catchTag`; do not swallow them.
- Provide a retry policy explicitly if retries are wanted.
- Dedicated pool-connection layers retain one connection for layer lifetime; they do not provide per-query pool concurrency.

## Safe Patterns

- `Effect.provide(program, PostgresScopedLayer({ acquire, release }))`
- `db.transaction(Effect.gen(function* () { ... }))`
- `withMode(layer, "trusted")` for validated hot paths.

## Unsafe Patterns

- Opening/closing raw client connections in userland.
- `withMode(layer, "unsafe-hot")` without an explicit opt-in reason.
- Catching all errors as untyped exceptions.

## Examples

```ts
const program = FindByEmail.execute({ email })
Effect.runPromise(program.pipe(Effect.provide(DatabaseLive)))
```

## Verification

- Test error channels with `FakeDriver` failures.
- Test transaction commit/rollback and savepoint nesting.
- Assert resource acquire/release under interruption.

## Hard Rule

Do not manually manage connections in userland unless building a driver adapter. Use Thor/Effect Layers.
