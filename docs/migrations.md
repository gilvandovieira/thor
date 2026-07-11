# Migrations: planning, policies, and expand/contract

Thor's live `Migrator` runs journaled, checksummed migrations one at a time under
the dialect's locking and transaction strategy. Beyond `up`/`down`/`check`, v1
adds reviewable planning, environment policies, expand/contract staging, and
typed backfills (spec §15).

## CLI workflow

Configure a schema module, migration directory, and database in
`thor.config.json`, then use the same live Migrator through the CLI:

```json
{
  "migrationsDir": "migrations",
  "schema": "src/schema.ts",
  "database": { "dialect": "sqlite", "url": "app.db" },
  "policy": "safe-only"
}
```

```sh
thor generate add_users  # additive create-table plans only
thor status
thor check
thor up
thor down
thor redo
thor drift
thor doctor
```

Migration files are loaded in filename order and must default-export
`defineMigration(...)`. `up` validates journal ordering/checksums and surfaces a
pre-migration structural drift report. Drift blocks an otherwise up-to-date run;
when migrations are pending it is reported as advisory because the intended
pending DDL normally explains the difference.

`generate` currently compares table presence and writes an irreversible
create-table migration. It does not infer column changes, renames, or reverse
operations; use reviewed manual migrations or the programmatic planning APIs for
those changes.

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

### Manual migrations obey the same policy

`up()` and `down()` enforce the active policy on the manual migrations they
execute — not only on generated plans passed to `apply()`. Because a manual
`sql`/`rawSql` body is **opaque** to Thor, you declare its risk class so the
policy can be applied:

```ts
defineMigration({
  id: "0007_drop_legacy",
  name: "drop_legacy",
  safety: "destructive",           // blocked under safe-only / expand-only
  phase: "contract",               // blocked under expand-only
  up: sql`drop table legacy`
})
```

- `safety: "destructive"` — blocked under `safe-only`, and under
  `allow-reviewed-destructive` unless the run sets `reviewed: true`.
- `safety: "additive"` (or omitted) — permitted under `safe-only`.
- `phase: "contract"` — blocked under `expand-only`.
- `disabled` / `validate-only` — no manual migration runs at all.

Rejection happens **before** any SQL reaches the driver, inside the migration
lock/transaction, so the journal is never written for a blocked step.

**Limitation.** Thor cannot infer safety from arbitrary SQL text. A migration
with no declared `safety` is treated as author-trusted **additive** and will
pass `safe-only`. Mark destructive migrations explicitly (or run every migration
under a reviewed `allow-reviewed-destructive` policy) to have them enforced. See
[limitations.md](./limitations.md#migrations).

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

## Routine DDL (§15.1, §14)

`CreateRoutine` / `DropRoutine` operations create and drop stored functions and
procedures. Bodies are dialect-specific PL code, so `returns`, `language`, and
`body` are **trusted SQL** — treat them like `unsafeSql`, never request data.

```ts
const op: MigrationOperation = {
  _tag: "CreateRoutine",
  routine: "function",
  name: "add_one",
  args: [{ name: "n", type: "integer" }],
  returns: "integer",
  language: "sql",
  body: "select n + 1",
  replace: true,
  destructive: false, reversible: true, capabilities: []
}
```

- **PostgreSQL** renders full `CREATE [OR REPLACE] FUNCTION/PROCEDURE … AS $$ … $$`.
- **MySQL** renders `CREATE FUNCTION/PROCEDURE …` (no `OR REPLACE`; drop takes no
  argument list). Multi-statement bodies need a DELIMITER-aware driver at
  execution time.
- **SQLite** has no stored routines, so these operations fail with a tagged
  `MigrationError` **before the driver**.

A created routine is an expand-phase step; a dropped one is contract-phase and
destructive, so it obeys the policy rules above.

## Transactional-DDL awareness (§15.1)

The migrator wraps each step in a transaction on dialects with transactional DDL
(PostgreSQL, SQLite) and applies without one where the backend does not support
it (MySQL), where a failed step can leave earlier DDL in place. This is driven by
the dialect's `transactionalDdl` capability, not a per-migration flag.
