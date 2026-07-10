---
name: thor-capabilities
description: "Check dialect and runtime capabilities before using features."
---

# Thor Skill: Capabilities

## Goal

Teach an agent to gate features on the dialect capability matrix and runtime capabilities, failing conservatively when support is missing.

## Use When

- The user uses `RETURNING`, CTEs, window functions, upserts, or runtime-specific adapters.

## Required Checks

- Every capability is `native`, `emulated`, `unsupported`, or `unknown`.
- Guards fail with a tagged `CapabilityError` before the driver runs — do not catch and emulate.
- Runtime capabilities (Node/Bun/SQLite) gate adapter selection separately.
- Inspect required capabilities with `query.requiredCapabilities()`.
- `thor capabilities <dialect>` prints the authoritative matrix.

## Safe Patterns

- Check `requiredCapabilities()` and branch, or let the guard reject before execution.
- Allow emulation only via an explicit policy where it is correct.

## Unsafe Patterns

- Assuming `RETURNING` works on MySQL (it does not).
- Faking portability by silently rewriting unsupported features.
- Ignoring an `unknown` capability.

## Examples

```ts
// MySQL rejects INSERT ... RETURNING before the driver:
Expect a CapabilityError, not a silent workaround.
```

## Verification

- Assert `CapabilityError` before the driver for unsupported features.
- Run the capability-aware dialect contract suite.
- Regenerate and diff the capability summary.

## Hard Rule

If a capability is unsupported or unknown, fail conservatively. Do not fake portability.
