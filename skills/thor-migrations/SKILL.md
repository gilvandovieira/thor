---
name: thor-migrations
description: "Create and review Thor migrations."
---

# Thor Skill: Migrations

## Goal

Teach an agent to author, plan, and review migrations with policies and expand/contract staging, never defaulting to destructive operations.

## Use When

- The user changes the schema, backfills data, or reviews pending migrations.

## Required Checks

- Preview with `Migrator.diff`/`plan`/`dryRun` before applying.
- Set a `policy` (`safe-only` default); destructive ops need `allow-reviewed-destructive` + `reviewed: true`.
- Stage breaking changes with `planExpandContract` (expand → backfill → require → contract).
- Use `backfill(effect)` for typed data steps; give Effect steps a `revision`.
- Run drift detection (`Introspector.drift`) before migrating.

## Safe Patterns

- `MigratorLive({ schema, policy: "safe-only" })`
- `planExpandContract("rename_name", { table, add, backfillSql, dropColumn })`
- `up: backfill(db.update(users).set({ ... }).run())` with a `revision`.

## Unsafe Patterns

- Generating `DropTable`/`DropColumn`/type-narrowing as a safe default.
- Applying a hand-built destructive plan without a reviewed policy.
- Editing an already-applied migration (checksum mismatch fails).

## Examples

```ts
const plan = yield* migrator.plan("add_posts")
const report = yield* migrator.dryRun()
yield* migrator.up() // applies pending under policy
```

## Verification

- Snapshot generated DDL per dialect.
- Test policy gating (safe-only blocks destructive; reviewed allows it).
- Test concurrency/failure paths and checksum validation.

## Hard Rule

Never generate destructive migrations as safe defaults. Drop table/drop column/type narrowing require explicit approval.
