# Migrations: planning, policies, and expand/contract

Thor's live `Migrator` runs journaled, checksummed migrations one at a time under
the dialect's locking and transaction strategy. Beyond `up`/`down`/`check`, v1
adds reviewable planning, environment policies, expand/contract staging, and
typed backfills (spec §15).

## Review before you apply

Three read-only APIs let you see a change before it runs:

```ts
const m = yield* Migrator

const ops    = yield* m.diff(["users"])        // raw operations vs a snapshot
const plan   = yield* m.plan("add_posts")      // a policy-guarded MigrationPlan
const report = yield* m.dryRun()               // what up() would apply, with SQL
```

- `diff` returns the raw, ungated `MigrationOperation[]`.
- `plan` returns a `MigrationPlan` after guarding it against the active policy
  (it is the same thing `generate` produces).
- `dryRun` returns `{ pending }` — the pending migrations `up()` would run and
  their compiled SQL — **without touching the database**.

## Migration policies (§15.4)

A policy gates what a run may do. Pass it in `MigratorConfig.policy`:

| Policy | Allows |
|---|---|
| `disabled` | nothing |
| `validate-only` | nothing is applied (plans are still validated) |
| `safe-only` *(default)* | additive/altering ops; **destructive ops blocked** |
| `expand-only` | only expand-phase (additive, non-breaking) ops |
| `allow-reviewed-destructive` | destructive ops **only** when the run sets `reviewed: true` |
| `allow-destructive` | everything (deprecated; prefer a reviewed run) |

`apply` is guarded too, so a hand-built destructive plan cannot bypass policy:

```ts
MigratorLive({ policy: "allow-reviewed-destructive", reviewed: true })
```

Every operation is classified `expand` or `contract` by `migrationPhase(op)`:
additive, non-breaking changes (create table, add a nullable/defaulted column,
drop NOT NULL) are **expand**; drops, renames, type changes, requiring a column,
and raw SQL are **contract**.

## Expand/contract staging (§15.5)

For a rolling deploy where old and new code coexist, split a breaking change into
ordered phases with `planExpandContract`:

```ts
const plans = planExpandContract("rename_name_to_display", {
  table: "users",
  add: { name: "display_name", type: "text", nullable: false },
  backfillSql: "update users set display_name = name",
  dropColumn: "name"
})
// → [ _1_expand (add nullable), _2_backfill, _3_require (SET NOT NULL), _4_contract (drop) ]
```

The column is always added **nullable** in the expand phase, and the final
contract (drop) plan is destructive — so it stays blocked until you apply it
under a reviewed destructive policy. Apply the plans in order with `m.apply`.

## Typed backfills (§15.1)

Wrap a normal typed query as a migration data step with `backfill`, then give the
migration an explicit `revision` so its checksum tracks the implementation:

```ts
defineMigration({
  id: "0003_backfill_display_name",
  name: "backfill display_name",
  revision: "1",
  up: backfill(db.update(users).set({ displayName: users.name }).run())
})
```

## Transactional-DDL awareness (§15.1)

The migrator wraps each step in a transaction on dialects with transactional DDL
(PostgreSQL, SQLite) and applies without one where the backend does not support
it (MySQL), where a failed step can leave earlier DDL in place. This is driven by
the dialect's `transactionalDdl` capability, not a per-migration flag.
