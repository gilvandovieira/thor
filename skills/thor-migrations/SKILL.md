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

- `Migrator.diff`/`plan` are create-table-only; use `dryRun` to preview pending authored steps.
- Set a `policy` (`safe-only` default); destructive ops need `allow-reviewed-destructive` + `reviewed: true`.
- Stage breaking changes with `planExpandContract` (expand → backfill → require → contract).
- Use `backfill(effect)` for typed data steps; give Effect steps a `revision`.
- Run drift detection (`Introspector.drift`) before migrating.
- Expect new journal checksums as `sha256:v1`; legacy rows verify without being rewritten.

## Safe Patterns

- `MigratorLive({ schema, policy: "safe-only" })`
- `planExpandContract("rename_name", { table, add, backfillSql, dropColumn })`
- `up: backfill(db.update(users).set({ ... }).run())` with a `revision`.

## Unsafe Patterns

- Generating `DropTable`/`DropColumn`/type-narrowing as a safe default.
- Applying a hand-built destructive plan without a reviewed policy.
- Treating opaque manual SQL as structurally verified or omitting explicit safety/phase metadata.
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
