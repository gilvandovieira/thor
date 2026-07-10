---
name: thor-safety
description: "Keep unsafe paths explicit, visible, and testable."
---

# Thor Skill: Safety

## Goal

Teach an agent that every unsafe path in Thor is opt-in, visible in the API, and testable — never a silent default.

## Use When

- The user needs raw SQL, unsafe-hot mode, destructive migrations, or parameter logging.

## Required Checks

- Dynamic SQL text requires `unsafeSql(...)`; ordinary interpolation is rejected.
- `unsafe-hot` execution mode skips decode and is opt-in only via `withMode`.
- Destructive migrations require a reviewed policy; production blocks them by default.
- Parameter logging defaults to none/redacted; `unsafe-full` is explicit.
- Routine names are never interpolated.

## Safe Patterns

- `unsafeSql(trustedFragment)` for genuinely dynamic, non-request text.
- `withMode(layer, "unsafe-hot")` only on pre-validated compiled paths.
- `db.withObservability({ logParams: "redacted" })`.

## Unsafe Patterns

- Passing request data to `unsafeSql`.
- Defaulting to `unsafe-hot` or `unsafe-full` param logging.
- Auto-applying destructive migrations.

## Examples

```ts
// Explicit, visible, testable:
const HotPath = withMode(PostgresLayer(client), "unsafe-hot")
```

## Verification

- Test that ordinary interpolation is rejected without `unsafeSql`.
- Assert no raw params/SQL leak by default (observability invariant).
- Test that destructive ops are blocked under the default policy.

## Hard Rule

Unsafe paths must be explicit, visible in the API, and testable.
