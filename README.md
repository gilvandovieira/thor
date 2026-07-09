# Thor

An **Effect-native ORM / database toolkit**: fluent schema & query authoring, a
typed + runtime IR, executable capability matrices, PostgreSQL, SQLite, and MySQL
dialects, typed Effect execution, first-class testing, and first-class
benchmarks.

> Status: **v0 vertical slice**. The full architecture is wired end-to-end for
> PostgreSQL, SQLite, and MySQL — schema → typed builder → runtime IR → guards → capability check →
> compile → execute → decode. The
> [updated v0 specification](docs/thor-project-spec-v0-updated.md) is the source
> of truth; see [Milestone status](#milestone-status) for implementation scope.

```
Schema DSL → Typed Query Builder → Typed + Runtime IR → Guards
   → Capability Matrix → Dialect Compiler → Effect Executor → Decoded Result
```

## Packages

| Package | What |
|---|---|
| `@gilvandovieira/thor` | The toolkit. Flat package with subpath exports. |
| `@gilvandovieira/cli` | The `thor` migration CLI. |

Subpaths: `@gilvandovieira/thor/{schema,sql,postgres,sqlite,mysql,migrate,testing,routine,capabilities}`.

## Quick start

```ts
import { pg, db, eq, param } from "@gilvandovieira/thor"
import { Schema, Effect } from "effect"
import { PostgresLayer } from "@gilvandovieira/thor/postgres"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})

// Pure builder — no Effect until you execute.
const query = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .limit(1)

query.toSql()      // { sql, paramOrder, cacheKey } — inspect without a DB
query.inspect()    // { kind, tables, params, cardinality, capabilities }

// Execution returns an Effect requiring the Database service.
const program = query.one({ email: "lucas@example.com" })
//    Effect<{ id: string; email: string }, DbError | NotFoundError | TooManyRowsError, Database>

Effect.runPromise(program.pipe(Effect.provide(PostgresLayer(pgClient))))
```

SQLite uses the same builder and migrator through its own dialect:

```ts
import { DatabaseSync } from "node:sqlite"
import { db, sqlite } from "@gilvandovieira/thor"
import { SQLiteDialect, SQLiteLayer } from "@gilvandovieira/thor/sqlite"

const client = new DatabaseSync(":memory:")
const notes = sqlite.table("notes", {
  id: sqlite.uuid("id").primaryKey().defaultRandom(),
  body: sqlite.text("body").notNull()
})

db.insert(notes).values({ body: "hello" }).returning({ id: notes.id }).one()
  .pipe(Effect.provide(SQLiteLayer(client)))

// Pure compilation is explicit when the default PostgreSQL dialect is not wanted.
db.select({ body: notes.body }).from(notes).toSql(SQLiteDialect)
```

MySQL uses the mysql2 Promise API structurally, without a runtime dependency:

```ts
import mysql2 from "mysql2/promise"
import { db, mysql } from "@gilvandovieira/thor"
import { MySQLLayer } from "@gilvandovieira/thor/mysql"

const connection = await mysql2.createConnection(process.env.MYSQL_URL!)
const users = mysql.table("users", {
  id: mysql.uuid("id").primaryKey().defaultRandom(),
  email: mysql.text("email").notNull()
})

db.insert(users).values({ email: "ada@example.com" }).run()
  .pipe(Effect.provide(MySQLLayer(connection)))
```

MySQL does not support DML `RETURNING`; Thor rejects it with `CapabilityError`
before calling the driver. Generated DDL uses a named migration lock but is not
wrapped in a transaction because MySQL DDL implicitly commits.

Schema-derived types (spec §5.1):

```ts
import type { Select, Insert, Update } from "@gilvandovieira/thor"

type UserRow    = Select<typeof users>  // { readonly id: string; email: string; age: number | null; ... }
type NewUser    = Insert<typeof users>  // { email: string; name: string; id?: string; age?: number | null; ... }
type UserPatch  = Update<typeof users>  // all non-generated columns optional
```

## Drivers & the contract suite (spec §14.10)

A single dialect can run behind interchangeable **driver adapters**, so the
`Driver` seam is client-agnostic. Postgres ships two:

```ts
import { PostgresLayer, PostgresJsLayer } from "@gilvandovieira/thor/postgres"

PostgresLayer(new Client({ connectionString }))          // node-postgres
PostgresJsLayer(postgres(connectionString, { max: 1 }))  // postgres.js
```

Both **Postgres** drivers pass the identical shared, capability-aware contract
suite against a real database. The same suite also covers `node:sqlite` in the
default test run, `bun:sqlite` in its explicit Bun harness, and `mysql2` against
real MySQL. CI runs the Node suite, the Bun contract harness, and a live
Postgres/MySQL service matrix.

The two Postgres drivers are benchmarked independently; see
[`docs/driver-benchmarks.md`](docs/driver-benchmarks.md). The historical
postgres.js write advantage applies to **unprepared** execution. With prepared
statements enabled the drivers converge, while Thor's own hot-path cost is about
2 µs for a static prepared handle and matters most for in-process databases.

```ts
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { makeDialectContractSuite } from "@gilvandovieira/thor/testing"

// Runner-agnostic: inject describe/it/expect, provide a driver layer.
makeDialectContractSuite({ describe, it, beforeAll, afterAll, beforeEach, expect }, {
  name: "postgres.js",
  dialect: PostgresDialect,
  reset: [
    "drop table if exists contract_users",
    "create table contract_users (id uuid primary key default gen_random_uuid(), email text not null unique, name text, age integer)"
  ],
  layer: PostgresJsLayer(sql),
  teardown: () => sql.end()
})
```

## Testing without a database (spec §14)

```ts
import { FakeDriver, FakeDatabaseLayer, expectSql } from "@gilvandovieira/thor/testing"

expectSql(query).sql        // assert compiled SQL
const driver = new FakeDriver().enqueue({ rows: [{ id: "u1", email: "a@b.c" }] })
Effect.provide(query.all(), FakeDatabaseLayer(driver))
driver.calls                // assert SQL was compiled + params bound
```

## API documentation

Source modules and named callables use standard JSDoc, including parameter,
return, error-channel, and generic contracts where relevant. The conventions
and templates live in [`docs/api-documentation.md`](docs/api-documentation.md).
Run `pnpm docs:check` to audit new source before submitting it.

## Design laws (spec §4)

- **Pure builder, Effect executor.** `db.select(...)` returns a plain `Query`;
  only `.all()/.one()/.maybeOne()/.run()` return an `Effect`.
- **Runtime IR is the source of truth.** The type-level IR sharpens inference;
  the runtime IR drives guards, compilation, decoding, and observability.
- **No silent emulation.** An unsupported capability fails with a typed
  `CapabilityError` before execution unless emulation is explicitly enabled.
- **Capabilities are executable metadata.** Encoded as a compact `bigint` bitset
  on the hot path; readable names at the boundary.

## Migrations (live, spec §13.7)

The programmatic migrator runs against a real `Database` and delegates locking
and transaction behavior to the active dialect. PostgreSQL uses an advisory lock
and transactional DDL, SQLite uses `begin immediate` without an external lock,
and MySQL uses a named lock while leaving implicitly committing DDL outside a
transaction. Every dialect journals applied migrations with checksums and fails
hard on checksum mismatch.

```ts
import { Effect, Layer } from "effect"
import { PostgresLayer } from "@gilvandovieira/thor/postgres"
import { Migrator, MigratorLive, defineMigration, sql, rawSql } from "@gilvandovieira/thor/migrate"
import { Client } from "pg"

const migrations = [
  defineMigration({
    id: "0001_create_users",
    name: "create_users",
    up: sql`create table users (id uuid primary key, email text not null unique);`,
    down: sql`drop table users;`
  }),
  defineMigration({
    id: "0002_backfill",
    name: "backfill",
    up: rawSql`update users set email = lower(email)`, // an Effect step, runs in the tx
    down: rawSql`select 1`
  })
]

// Back the migrator with a single-connection client (it issues begin/commit + locks).
const app = Layer.provideMerge(MigratorLive({ migrations, schema: [users] }), PostgresLayer(client))

const program = Effect.gen(function* () {
  const m = yield* Migrator
  yield* m.up()                         // apply pending, transactionally + journaled
  yield* m.check()                      // validate order + journal checksums
  const plan = yield* m.generate("init", [])  // diff schema -> create-only plan
  yield* m.apply(plan)                  // apply a generated plan
  yield* m.drift()                      // ops needed to reconcile DB vs code
  // yield* m.down()                    // roll back the last migration if reversible
})

Effect.runPromise(Effect.provide(program, app))
```

## CLI

```sh
thor init                    # config + migrations/ + journal
thor create add_users_table  # new manual migration
thor status                  # applied / pending
thor check                   # validate order + destructive ops
# up / down / generate / drift / snapshot / pull — share the same migration IR
```

## Develop

```sh
pnpm install
pnpm build        # tsc -b across packages
pnpm test         # vitest unit tests (schema types, compile, guards, execution, migrate, caps)
pnpm bench        # micro-benchmarks for build / compile hot paths
pnpm typecheck
```

### End-to-end tests (real Postgres and MySQL)

E2E tests run both Postgres adapters, the live Postgres migrator, and the MySQL
adapter against Dockerized databases. Each live suite is skipped when its
corresponding `DATABASE_URL` or `MYSQL_URL` is absent. SQLite's Node contract
runs in `pnpm test`; its Bun contract has a separate explicit command.

```sh
pnpm e2e          # docker compose up --wait → build → e2e tests → compose down -v

# or manually:
pnpm db:up
DATABASE_URL=postgres://thor:thor@localhost:5433/thor \
MYSQL_URL=mysql://thor:thor@localhost:3307/thor pnpm test:e2e
pnpm db:down

pnpm test:contract:sqlite:bun
```

The live suite covers the shared capability-aware driver contract on Postgres
and MySQL. Postgres additionally covers migration `up` (SQL + Effect steps,
journaled), idempotent re-run, `down`, transactional rollback, checksum
validation, `generate` + `apply`, `drift`, and a full query round-trip.

## Milestone status

| Milestone | Status |
|---|---|
| 0 — Repo & package skeleton | ✅ pnpm workspace, TS project refs, exports, tests, bench |
| 1 — Core schema & IR | ✅ table/column DSL, Select/Insert/Update derivation, query IR, errors, capability types |
| 2 — Query builder | ✅ select/insert/update/delete, predicates, params, returning, cardinality methods |
| 3 — Guards & capabilities | ✅ scope/shape/returning guards, capability bitset + PostgreSQL/SQLite/MySQL matrices, typed `CapabilityError` |
| 4 — Dialect compilers | ✅ select/insert/update/delete, safe identifiers/placeholders, value-independent cache keys for PostgreSQL/SQLite/MySQL |
| 5 — Effect execution | ✅ `Database` service, driver contract, PostgreSQL/SQLite/MySQL adapters, all/one/maybeOne/run, decode pipeline |
| 6 — Testing | 🟡 shared capability-aware contract suite across all adapters; executable SQL matrix Levels 1–5 and 7; deterministic property/fuzz invariants include joins/subqueries · remaining type/transaction/routine/DDL matrix levels are tracked in G6 |
| 7 — Benchmarks | ✅ Node/Bun lanes, prepared off/on, cold/warm/static-handle and mode axes, ~2.06 µs handle tracking, and a noise-tolerant CI regression gate |
| 8 — Migrations | 🟡 IR, `defineMigration`, DDL compiler, diff, guards, journal, checksum, CLI `init/create/status/check`, **live migrator** (`up`/`down`/`generate`/`apply`/`check`/`drift`) with dialect-aware lock/transaction lifecycle, verified by real-Postgres e2e tests · CLI file-loading of `up/down/pull` remains |
| 9 — Routines | 🟡 typed descriptors & IR (`defineFunction/Procedure/TableFunction`) — expression/`from` lowering pending |
| Cross-cutting — Dialects | ✅ PostgreSQL, SQLite, and MySQL query/migration dialects with declared capability profiles |
| Cross-cutting — Runtime portability | ✅ Node and Bun SQLite contract harnesses run locally and in separate CI lanes |
| Cross-cutting — Modes & handles | ✅ safe/trusted/unsafe modes and reusable `.prepare()` handles with capability checks preserved |

Legend: ✅ implemented · 🟡 partial, with remaining work stated explicitly.

## Spec v0 (updated) alignment

The [updated spec](docs/thor-project-spec-v0-updated.md) extends v0 with multi-dialect
targets, runtime portability, a performance program, and a broader test matrix.
Progress against it, with tasks broken out in [`docs/roadmap.md`](docs/roadmap.md):

| Workstream | Spec | Status |
|---|---|---|
| Dialects: PostgreSQL / SQLite / MySQL | §2A.1 | ✅ three dialects with capability matrices + subpath exports |
| Multi-dialect contract-suite coverage | §2A.1, §18.6 | ✅ identical suite passes two Postgres drivers, Node SQLite, Bun SQLite, and MySQL; CI runs unit, Bun, and live-database lanes |
| Runtime portability (Node + Bun) | §2A.2, §18.7 | ✅ explicit Node and Bun SQLite contract harnesses run in separate CI jobs (C3) |
| Runtime capabilities (`runtime.*`) | §2A.3 | ✅ detected profiles, mandatory driver declarations, and early adapter validation (Epic C1–C2) |
| Precompiled `.prepare()` query handles | §15.13, §15.15 | ✅ static handles precompute shape guards/hash/decoder and cache compilation + capability results per dialect profile (Epic D) |
| Performance modes (safe/trusted/unsafe) | §15.13 | ✅ safe default, strict trusted mode, opt-in unsafe decode bypass; capability checks remain mandatory (Epic E) |
| Cache-key composition + optimization audit | §15.14 | ✅ versioned dialect profiles, normalized IR hashes, full plan keys, and required strategy audit (Epic F) |
| SQL feature matrix tests | §14.11 | 🟡 executable, capability-aware matrix covers Levels 1–5 and 7 across all dialects, with live SQLite validation; Levels 6 and 8–10 remain (G6) |
| Property & fuzz tests | §14.12 | ✅ deterministic invariants cover basic queries, mutations, joins, and correlated subqueries across all dialect compilers (Epic H) |
| Hot-path targets + CI perf gates | §15.12, §15.16 | ✅ Node/Bun tracking, staged `bench:gate`, baseline handling, and CI invocation are implemented |

The cache-key layers and completed §15.14 checklist are documented in
[`docs/optimization-strategies.md`](docs/optimization-strategies.md).
Advanced query APIs and their capability boundaries are documented in
[`docs/advanced-queries.md`](docs/advanced-queries.md).

## Prepared query handles

Hoist static query shapes with `.prepare(name)`. A handle snapshots the IR,
precomputes its decoder, structural guard, capability bits, parameter order,
hash, and tracing metadata, then compiles and validates once per dialect
profile:

```ts
const FindUserByEmail = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .prepare("FindUserByEmail")

yield* FindUserByEmail.one({ email: "ada@example.com" })
```

Prepared handles never capture parameter values. Mutation handles use named
parameters in `values()` or `set()` and receive values at execution:

```ts
const CreateUser = db
  .insert(users)
  .values({ email: param("email", Schema.String) })
  .returning({ id: users.id })
  .prepare("CreateUser")

yield* CreateUser.one({ email: "ada@example.com" })
```

Attempting to prepare a shape containing an inline-bound value throws the tagged
`GuardError` with guard `prepared-values`. The hot-path benchmark measures the
static handle at about 2.06 µs, roughly 1.5–1.6× faster than the memoized fluent
path; see [`docs/driver-benchmarks.md`](docs/driver-benchmarks.md).

## Runtime portability

Database capabilities and JavaScript runtime capabilities are independent. A
driver declares its runtime contract through `Driver.runtime`; structural
drivers are runtime-neutral, while the built-in SQLite wrappers validate their
host before any statement reaches the client:

```ts
import { detectRuntimeCapabilities } from "@gilvandovieira/thor/capabilities"
import { BunSQLiteLayer, NodeSQLiteLayer } from "@gilvandovieira/thor/sqlite"

const runtime = detectRuntimeCapabilities()
runtime.capabilities.has("runtime.sqlite.bun")

NodeSQLiteLayer(nodeClient) // requires runtime.node + runtime.sqlite.node
BunSQLiteLayer(bunClient)   // requires runtime.bun + runtime.sqlite.bun
```

A mismatch throws the tagged `RuntimeCapabilityError` while constructing the
adapter. The shared SQLite dialect/compiler remains unchanged. Top-level
`/node` and `/bun` package subpaths are intentionally deferred because the
runtime-specific surface is currently SQLite-only and fits the `/sqlite`
boundary.

The runtime contract harnesses are separate and explicit:

```sh
pnpm test:contract:sqlite:node  # Vitest + node:sqlite + NodeSQLiteLayer
pnpm test:contract:sqlite:bun   # bun:test + bun:sqlite + BunSQLiteLayer
pnpm test:contract:sqlite       # run both parity lanes
```

Both register the same `makeDialectContractSuite` and
`SQLITE_CONTRACT_RESET`; CI keeps them in separate Node and Bun jobs.

See the [updated specification](docs/thor-project-spec-v0-updated.md) for the full
document (the earlier [`thor-project-spec.md`](docs/thor-project-spec.md) is superseded).
