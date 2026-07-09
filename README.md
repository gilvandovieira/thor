# Thor

Thor is a database toolkit for TypeScript, built for [Effect](https://effect.website).
You describe your tables and queries in plain, fluent TypeScript; Thor gives you
back fully-typed results and runs them against **PostgreSQL, SQLite, or MySQL** —
the same code, three databases.

Two ideas make it different from most query builders:

- **Nothing touches your database until you ask it to.** Building a query is a
  pure value — you can print the SQL, inspect it, cache it, or throw it away, all
  without a connection. Only the final `.all()` / `.one()` / `.run()` reaches out
  to the database, and it does so as an Effect, so errors and resources are
  handled the Effect way.
- **No surprises at runtime.** Thor knows exactly what each database can and
  can't do. Ask MySQL for `INSERT ... RETURNING` and you get a clear
  `CapabilityError` *before* anything runs — never a silent workaround or a
  cryptic driver error.

```
Your tables  →  a query you build  →  checked against the database's abilities
             →  compiled to SQL     →  run as an Effect  →  typed rows back
```

## Install

```sh
pnpm add @gilvandovieira/thor effect
```

Everything ships from one package. The common things (`db`, `pg`, `eq`, `param`,
…) come from the top level; deeper surfaces live under subpaths like
`@gilvandovieira/thor/postgres`, `/sqlite`, `/mysql`, `/migrate`, and `/testing`.

## A quick tour

Say you're building a small blog. You have authors, and authors write posts.
Here's the whole journey — from describing the tables to reading real data back.

### 1. Describe your tables

```ts
import { pg } from "@gilvandovieira/thor"

const authors = pg.table("authors", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  name: pg.text("name").notNull()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  authorId: pg.uuid("author_id").notNull(),
  title: pg.text("title").notNull(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})
```

Your row types come for free — no code generation, no manual interfaces:

```ts
import type { Select, Insert } from "@gilvandovieira/thor"

type Post    = Select<typeof posts>  // { id: string; authorId: string; title: string; createdAt: Date }
type NewPost = Insert<typeof posts>  // { authorId: string; title: string; id?: string; createdAt?: Date }
```

### 2. Write a query — and look at it before running anything

```ts
import { db, eq, param } from "@gilvandovieira/thor"
import { Schema } from "effect"

const postsByAuthor = db
  .select({ id: posts.id, title: posts.title })
  .from(posts)
  .where(eq(posts.authorId, param("authorId", Schema.String)))

// It's just a value. Inspect it with no database in sight:
postsByAuthor.toSql()      // → { sql, paramOrder, cacheKey }
postsByAuthor.inspect()    // → { kind, tables, params, cardinality, capabilities }
```

Notice `param("authorId", …)` — queries carry *named holes*, not baked-in
values. You fill them in at run time, and the same compiled SQL is reused for
every author.

### 3. Run it

Only now does Effect enter. `.one()` expects exactly one row and gives you a
typed result; `.all()` returns every match; `.run()` is for writes.

```ts
import { Effect } from "effect"
import { Client } from "pg"
import { PostgresLayer } from "@gilvandovieira/thor/postgres"

const program = postsByAuthor.all({ authorId: "ada-id" })
//    Effect<ReadonlyArray<{ id: string; title: string }>, DbError, Database>

const client = new Client({ connectionString: process.env.DATABASE_URL })
Effect.runPromise(program.pipe(Effect.provide(PostgresLayer(client))))
```

### 4. Ask a real question — a join and a count

Now the payoff. Which authors are most prolific? Join posts to their author and
count per name — the same fluent builder, still fully typed:

```ts
import { count } from "@gilvandovieira/thor"

const leaderboard = db
  .select({ author: authors.name, posts: count() })
  .from(posts)
  .innerJoin(authors, eq(posts.authorId, authors.id))
  .groupBy(authors.name)

await Effect.runPromise(leaderboard.all().pipe(Effect.provide(PostgresLayer(client))))
// → [{ author: "Ada", posts: 12 }, { author: "Grace", posts: 7 }, …]
```

Thor supports the queries real apps need: inner/left/right/full joins,
subqueries (correlated too), `count`/`sum`/`avg`/`min`/`max`, `groupBy` +
`having`, window functions, CTEs (including recursive), set operations
(`union`/`intersect`/`except`), and upserts. See
[`docs/advanced-queries.md`](docs/advanced-queries.md) for the full menu.

## Same query, other databases

The builder never changes — only the layer you provide at execution, and
(optionally) the dialect you compile against.

```ts
// SQLite
import { db, sqlite } from "@gilvandovieira/thor"
import { SQLiteDialect, SQLiteLayer } from "@gilvandovieira/thor/sqlite"

const notes = sqlite.table("notes", {
  id: sqlite.uuid("id").primaryKey().defaultRandom(),
  body: sqlite.text("body").notNull()
})

db.insert(notes).values({ body: "hello" }).returning({ id: notes.id }).one()
  .pipe(Effect.provide(SQLiteLayer(client)))

// Compile against a specific dialect without executing:
db.select({ body: notes.body }).from(notes).toSql(SQLiteDialect)
```

```ts
// MySQL (uses the mysql2 promise API; no runtime dependency on it)
import { db, mysql } from "@gilvandovieira/thor"
import { MySQLLayer } from "@gilvandovieira/thor/mysql"

const users = mysql.table("users", {
  id: mysql.uuid("id").primaryKey().defaultRandom(),
  email: mysql.text("email").notNull()
})

db.insert(users).values({ email: "ada@example.com" }).run()
  .pipe(Effect.provide(MySQLLayer(connection)))
```

MySQL has no `RETURNING`, so Thor stops that query with a `CapabilityError`
before it ever reaches the driver — the "no surprises" promise in action.

## Testing without a database

You don't need Postgres running to test your queries. `FakeDriver` records what
was compiled and hands back rows you queue up:

```ts
import { FakeDriver, FakeDatabaseLayer, expectSql } from "@gilvandovieira/thor/testing"

expectSql(postsByAuthor).sql               // assert the compiled SQL
const driver = new FakeDriver().enqueue({ rows: [{ id: "p1", title: "Hello" }] })
Effect.provide(postsByAuthor.all({ authorId: "ada-id" }), FakeDatabaseLayer(driver))
driver.calls                               // inspect the SQL + bound params
```

The testing subpath also ships the **contract suite** every dialect must pass,
so all three databases behave consistently.

## Migrations

Thor has a live migrator and a `thor` CLI. Migrations are transactional and
journaled with checksums; Thor picks the right locking strategy per database
(advisory lock on Postgres, `begin immediate` on SQLite, a named lock on MySQL).

```ts
import { Migrator, MigratorLive, defineMigration, sql } from "@gilvandovieira/thor/migrate"

const migrations = [
  defineMigration({
    id: "0001_create_authors",
    name: "create_authors",
    up: sql`create table authors (id uuid primary key, name text not null);`,
    down: sql`drop table authors;`
  })
]

const program = Effect.gen(function* () {
  const m = yield* Migrator
  yield* m.up()      // apply everything pending, transactionally
  yield* m.check()   // verify order + checksums
  yield* m.drift()   // what would it take to match your schema to the DB?
})
```

```sh
thor init          # scaffold config + migrations/ + journal
thor create <name> # new migration file
thor status        # applied vs pending
thor check         # validate order + flag destructive ops
# up · down · generate · drift · snapshot · pull  — stubs today;
#   live-DB wiring to the migrator is tracked as Epic T. The live migrator
#   itself already works programmatically (see above).
```

## Where things stand

Thor's full pipeline works end-to-end today on **all three databases**: schema →
typed builder → runtime IR → capability check → compile → execute → decode.

| Area | State |
|---|---|
| Schema & typed row derivation | ✅ Done |
| Query builder (select/insert/update/delete, predicates, params) | ✅ Done |
| Advanced queries (joins, aggregation, windows, CTEs, sets, upserts) | ✅ Done |
| Guards & capability checks | ✅ Done |
| PostgreSQL / SQLite / MySQL dialects | ✅ Done |
| Effect execution + drivers (2 Postgres drivers, Node & Bun SQLite, mysql2) | ✅ Done |
| Prepared handles & performance modes | ✅ Done |
| Benchmarks + CI regression gate | ✅ Done |
| Testing helpers & cross-dialect contract suite | ✅ Done |
| Migrations (live migrator + CLI) | 🟡 Live migrator fully works programmatically; the DB-connected CLI commands (`up`/`down`/`generate`/`drift`/`pull`) are still stubs (Epic T) |
| SQL feature-matrix tests | 🟡 Levels 1–5, 7, and 9 covered; Levels 6, 8, and 10 remain |
| Stored routines (functions/procedures) | 🟡 Scalar/aggregate expressions, table-function sources, procedure commands, capability guards, and return decoding done; advanced named/out arguments and routine DDL remain |

Task-level detail lives in [`docs/roadmap.md`](docs/roadmap.md); the design of
record is [`docs/thor-project-v1-spec.md`](docs/thor-project-v1-spec.md).

## Working on Thor

```sh
pnpm install
pnpm build        # tsc -b across packages (project references)
pnpm test         # vitest — but build first (tests import the built package, not src)
pnpm typecheck
pnpm docs:check   # JSDoc completeness — required before submitting src changes
```

> **Gotcha:** tests import the package by name, which resolves to `dist`, not
> `src`. Run `pnpm build` before `pnpm test` after editing source. The
> `e2e`/`contract`/`bench` scripts build for you; bare `pnpm test` does not.

End-to-end tests run against real Postgres and MySQL in Docker (skipped unless
`DATABASE_URL` / `MYSQL_URL` are set); SQLite runs in-memory in the default
suite:

```sh
pnpm e2e          # compose up → build → e2e tests → compose down
pnpm db:up        # or start postgres@5433 + mysql@3307 yourself
```

## Learn more

- [`docs/advanced-queries.md`](docs/advanced-queries.md) — joins, subqueries, aggregation, CTEs, upserts
- [`docs/routines.md`](docs/routines.md) — declared functions, table-valued sources, procedures, and capability behavior
- [`docs/driver-benchmarks.md`](docs/driver-benchmarks.md) — the two Postgres drivers, prepared vs unprepared, hot-path cost
- [`docs/optimization-strategies.md`](docs/optimization-strategies.md) — cache keys and the hot path
- [`docs/api-documentation.md`](docs/api-documentation.md) — JSDoc conventions
- [`docs/thor-project-v1-spec.md`](docs/thor-project-v1-spec.md) — the specification · [`docs/roadmap.md`](docs/roadmap.md) — progress by epic
</content>
</invoke>
