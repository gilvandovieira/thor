# Error model

Thor's failures are **tagged errors** (`Data.TaggedError`), so you discriminate
them with `Effect.catchTag(...)` and match on structured fields — never on
message strings (spec §22). Every error has a `_tag`, a stable category,
structured fields, an optional `cause`, and a safe summary `message`.

```ts
program.pipe(
  Effect.catchTag("ConstraintError", (e) => e.kind === "unique" ? recover(e) : Effect.fail(e)),
  Effect.catchTag("NotFoundError", () => Effect.succeed(null))
)
```

## The frozen public error set

Every public tagged error and its fields. This set is frozen — `errors.test.ts`
asserts it, so adding or removing an error is a deliberate change.

| `_tag` | Category | Fields (besides `message`) | Raised when |
|---|---|---|---|
| `CapabilityError` | capability | `capability`, `dialect` | a required capability is not `native` (no emulation) — before the driver runs |
| `RuntimeCapabilityError` | capability | `adapter`, `runtime`, `required`, `missing` | a driver adapter lacks the host's runtime capabilities |
| `CompileError` | compile | `detail?` | the IR cannot be lowered to dialect SQL (e.g. a compiled-query dialect-profile mismatch) |
| `DriverError` | driver | `cause?` | the driver rejected the statement (connection, syntax, protocol) — also the surface for introspection failures |
| `ConstraintError` | driver | `constraint`, `kind` (`unique`/`foreignKey`/`check`/`notNull`/`unknown`), `cause?` | a database constraint was violated |
| `DecodeError` | decode | `cause?` | a row failed to decode through its declared codec |
| `ParameterError` | parameter | `parameter?`, `reason` (`missing`/`extra`/`invalid`/`duplicate`/`conflict`), `cause?` | named query arguments failed validation or encoding |
| `NotFoundError` | cardinality | — | `.one()` found zero rows |
| `TooManyRowsError` | cardinality | `count` | `.one()`/`.maybeOne()` found more than one row |
| `GuardError` | guard | `guard` | a guard rejected an operation at construction or before execution — includes relation-planning, aggregation-scope, and unsafe-interpolation guards |
| `MigrationError` | migration | `migrationId?`, `cause?` | migration planning or execution failed |
| `IrreversibleMigrationError` | migration | `migrationId?` | an irreversible migration's `down` was requested |
| `TransactionError` | transaction | `cause?` | a transaction lifecycle problem (nested retry, escaped scope) — also the surface for retry-safety failures |
| `TimeoutError` | timeout | — | a statement exceeded its deadline or was interrupted |
| `RoutineError` | routine | `routine`, `cause?` | a routine (function/procedure) call failed |

`ThorError` is the union of all of these; `QueryError` is the subset that can
surface from executing a query (`GuardError`, `CapabilityError`, `CompileError`,
`DriverError`, `ConstraintError`, `DecodeError`, `ParameterError`).

### Consolidated spec §22 names

Spec §22 lists a few aspirational error names that Thor **consolidated** into the
tags above rather than shipping as separate types. Catch the real tag:

| Spec §22 name | Real tag | Discriminator |
|---|---|---|
| `IntrospectionError` | `DriverError` | introspection reads through the driver |
| `RelationPlanningError` | `GuardError` | `guard` starts with `relation-` |
| `RetrySafetyError` | `TransactionError` | retry-boundary message |
| `CacheError` | — | caches are pure and never fail |

## Completeness (V4)

The domain error surface — everything reachable through an Effect error channel —
is fully tagged. The remaining `throw`s in the source are **not** domain errors:

- **Programmer errors** (invalid API usage, thrown synchronously at construction):
  `unsafeSql`/migration interpolation misuse, an out-of-range cache `maxSize`, an
  unknown capability name. These are `TypeError`/`RangeError`, the JavaScript
  convention for contract violations — not recoverable domain failures.
- **Internal invariants wrapped at the boundary**: dialect DDL compilers throw
  for unsupported operations, but the migrator wraps `compileOperation` in
  `Effect.try`, so callers always see a `MigrationError`; driver response
  invariants surface as `DriverError`.

So there is no domain failure that reaches a caller as an untagged exception.
