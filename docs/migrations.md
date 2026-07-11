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

Migration `SqlStatement` values must come from `sql` or `sqlStatement`; a plain
object with the same `_tag` is not accepted at runtime. Statements are frozen and
authenticated by a package-private registry. Because TypeScript migration modules
may be evaluated through a separate physical Thor copy, the CLI validates the
loaded statement's tag and string payload as trusted authored source, then
reconstructs it with its own `sqlStatement` constructor. This is a deliberate CLI
source boundary, not general cross-copy value interoperability.

`generate`, `diff`, and `plan` currently compare table presence and produce
create-table operations only. They do not infer column changes, renames,
standalone index/constraint changes, or reverse operations. Author reviewed
manual operations for those changes; `planExpandContract` only covers the narrow
column-replacement workflow described below.

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
  authored SQL text where available — **without applying migration steps**.
  Effect steps are opaque and cannot be rendered as SQL.

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
const migrator = yield* makeMigrator({ policy: "allow-reviewed-destructive" })
yield* migrator.apply(plan, { reviewed: true })
```

Review approval belongs to one invocation, not project configuration. The CLI
equivalent is `thor up --reviewed`, `thor down --reviewed`, or
`thor redo --reviewed`.

Operation plans are structurally classified. Manual SQL and Effect migrations
are opaque, so policy relies on their explicit `safety` and `phase` metadata;
Thor cannot prove an arbitrary SQL string additive. Always declare both fields
for manual migrations and treat unchecked SQL as reviewed-only.

### Manual migrations obey the same policy

`up()` and `down()` enforce the active policy on the manual migrations they
execute — not only on generated plans passed to `apply()`. Because a manual
`sql`/`rawSql` body is **opaque** to Thor, you declare its risk class so the
policy can be applied:

```ts
defineMigration({
  id: "0007_add_flag",
  name: "add_flag",
  safety: "additive",              // forward step; permitted under safe-only
  phase: "expand",
  downSafety: "destructive",       // rollback drops the column → reviewed-only
  downPhase: "contract",
  up: sql`alter table users add column flag boolean`,
  down: sql`alter table users drop column flag`
})
```

The **forward** (`up`) direction is guarded by `safety`/`phase`; the **rollback**
(`down`) direction is guarded independently by `downSafety`/`downPhase`, because
rolling an additive change back is often destructive (Finding 3).

- `safety: "additive"` — permitted under `safe-only`.
- `safety: "destructive"` — blocked under `safe-only`/`expand-only`; runs only
  under `allow-reviewed-destructive` with `reviewed: true`.
- **omitted `safety`** — treated as *unchecked*: blocked under
  `safe-only`/`expand-only`; it requires `allow-reviewed-destructive` and an
  explicitly reviewed invocation. Thor cannot prove opaque SQL is additive, so
  it is **never silently treated as safe** (Finding 2).
- `phase: "contract"` — blocked under `expand-only`.
- `disabled` / `validate-only` — no manual migration runs at all.

The **whole pending set is preflighted** under the lock before the first step is
applied, so an earlier allowed migration is never committed only for a later one
to be rejected (Finding 12). Rejection happens **before** any SQL reaches the
driver, so the journal is never written for a blocked step. See
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
contract (drop) plan is destructive, so it stays blocked until reviewed. This is
a programmatic helper, not a `thor generate --strategy` option. Its `SET NOT
NULL` stage currently compiles end-to-end only for PostgreSQL; SQLite and MySQL
require reviewed backend-specific table alteration/rebuild plans.

Thor has no dedicated seed workflow. Data initialization can use normal typed
queries or reviewed backfills, but repeatable/environment-specific seed state is
not modeled or journaled separately.

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
`body` are dialect syntax and therefore require an explicit `unsafeSql` value;
never construct them from request data.

```ts
import { unsafeSql } from "@gilvandovieira/thor/migrate"

const op: MigrationOperation = {
  _tag: "CreateRoutine",
  routine: "function",
  name: "add_one",
  args: [{ name: "n", type: unsafeSql("integer") }],
  returns: unsafeSql("integer"),
  language: unsafeSql("sql"),
  body: unsafeSql("select n + 1"),
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

## Journal checksum format

New manual and generated-plan journal entries use `sha256:v1:<64 hex chars>`.
The canonical material includes ID, name, up/down representation, Effect
revision, irreversible marker, and safety/phase metadata. Thor accepts a matching
legacy eight-character FNV-1a checksum for databases created by earlier builds
without rewriting journal history. A checksum with an unknown algorithm/version
fails with a tagged `MigrationError`; upgrade Thor before applying migrations.

## Transactional-DDL awareness (§15.1)

The migrator wraps each step in a transaction on dialects with transactional DDL
(PostgreSQL, SQLite) and applies without one where the backend does not support
it (MySQL), where a failed step can leave earlier DDL in place. This is driven by
the dialect's `transactionalDdl` capability, not a per-migration flag.
