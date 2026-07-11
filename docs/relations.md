# Relations

Thor's experimental relation layer declares typed edges over schema foreign-key
metadata and loads them through the normal query IR. Import it from the package
root or from `@gilvandovieira/thor/relations`:

```ts
import { pg } from "@gilvandovieira/thor"
import {
  defineRelations,
  many,
  one,
  withRelations
} from "@gilvandovieira/thor/relations"
```

## Schema and graph

Define foreign keys in the schema before declaring relations. Graph keys are
physical source-table names, and `fields` and `references` are ordered,
non-empty key tuples of equal length.

```ts
const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull().unique()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").references(() => users.id),
  title: pg.text("title").notNull()
})

const relations = defineRelations({
  users: {
    posts: many(posts, {
      fields: [users.id],
      references: [posts.userId]
    })
  },
  posts: {
    author: one(users, {
      fields: [posts.userId],
      references: [users.id]
    })
  }
})
```

`one` must follow a foreign key from its source fields to a primary or unique
target key. `many` is the inverse: the target reference fields must have foreign
key metadata pointing back to the source fields. Column ownership, SQL data
types, tuple shape, uniqueness, and FK metadata are checked by
`defineRelations`. Aliased tables cannot be relation targets.

## Loading relations

Bind the graph once, select a root table, and give every included edge an
explicit strategy:

```ts
const relationalDb = withRelations(relations)

const usersWithPosts = relationalDb.relation(users).findMany({
  with: {
    posts: { strategy: "query" }
  }
})

// Effect<
//   ReadonlyArray<Select<typeof users> & {
//     readonly posts: ReadonlyArray<Select<typeof posts>>
//   }>,
//   QueryError,
//   Database
// >
```

The result contains the full decoded root row plus only the requested relation
properties. A `many` property is a readonly array, including `[]` when no rows
match. A `one` property is the decoded target row or `null`.

The three strategies are explicit execution choices:

```ts
const joined = relationalDb.relation(users).findMany({
  with: { posts: { strategy: "join" } }
})

const batched = relationalDb.relation(users).findMany({
  with: { posts: { strategy: "query" } }
})
```

- `join` emits one root statement with a `LEFT JOIN`, then groups and
  deduplicates decoded rows in memory.
- `query` reads roots first, collects distinct non-null source keys, and queries
  each relation in key batches. A one-column edge uses `IN`; composite edges use
  an OR of key-tuple comparisons.
- `manual` invokes one loader for the edge with all distinct source key tuples.
  The loader returns target rows, and Thor performs the same in-memory matching.

A manual loader can compose any `Effect` with the required `Database`
environment. This example builds one explicit batch query:

```ts
import { Effect } from "effect"
import { db, inArray } from "@gilvandovieira/thor"

const manuallyLoaded = relationalDb.relation(users).findMany({
  with: {
    posts: {
      strategy: "manual",
      load: ({ keys }) => {
        const userIds = keys.map(([userId]) => userId as string)
        return userIds.length === 0
          ? Effect.succeed([])
          : db.select({
              id: posts.id,
              userId: posts.userId,
              title: posts.title
            }).from(posts).where(inArray(posts.userId, userIds)).all()
      }
    }
  }
})
```

Manual loaders are called once per selected edge, not once per parent. They are
responsible for fetching target-shaped rows and for their own query policy; use
Thor queries inside the loader to retain normal compilation, guards, and decode.

## SQL and query count

There is no hidden N+1 behavior. Loading work depends on selected edges and key
batches, never directly on the number of parent rows:

| Plan | Driver statements |
|---|---:|
| only `join` edges | 1 |
| one `query` edge | 1 root + key batches |
| mixed strategies | 1 joined root + batches/manual loader work |

`query` derives the active dialect's native placeholder budget and caps relation
predicates at 800 bound key values per batch. Its batch size is
`floor(availableBudget / keyColumnCount)`. Duplicate parent keys are queried
once, and an edge with no matchable keys issues no target query. A composite key
wider than the available budget fails with `GuardError` before the root query or
target driver call; there is no oversized one-key batch and no N+1 fallback.
The conservative cap also limits expression depth and practical MySQL packet
growth; boundary-test production-like row widths and payload sizes.
Selecting several `join` edges still emits one statement, but SQL joins can
multiply flat rows before Thor groups them. Prefer `query` for large fan-outs;
measure both strategies with production-like cardinalities.

The root table and every joined target need a primary key because `join` uses
primary-key identity to group roots and deduplicate children. `query` and
`manual` do not impose this additional planner requirement, although the FK and
uniqueness rules used by relation declarations still apply.

All generated `join` and `query` statements pass through query IR, structural
guards, dialect capabilities, compilation, execution, and decoding. Relation
loading does not introduce an unsafe SQL bypass.

## Guard errors

Invalid declarations throw `GuardError` synchronously from `defineRelations`.
Examples include mismatched FK metadata, wrong column ownership or types,
non-unique `one` targets, and aliased targets.

Invalid loading plans fail with `GuardError` in the returned Effect's error
channel before driver I/O. This covers unknown relations, missing or unknown
strategies, a missing manual loader, and primary-key requirements for joins.
Discriminate on `_tag === "GuardError"` and the structured `guard` field rather
than matching message text. Relation guard names start with `relation-`.

## Testing

`FakeDriver` makes SQL, parameters, and statement counts deterministic without a
database. Queue one response per expected statement and provide its layer:

```ts
import { Effect } from "effect"
import { expect, it } from "vitest"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

it("batches relation keys", async () => {
  const driver = new FakeDriver().enqueue(
    { rows: [
      { id: "u1", email: "one@example.com" },
      { id: "u2", email: "two@example.com" }
    ] },
    { rows: [
      { id: "p1", userId: "u1", title: "First" }
    ] }
  )

  const rows = await Effect.runPromise(
    relationalDb.relation(users).findMany({
      with: { posts: { strategy: "query" } }
    }).pipe(Effect.provide(FakeDatabaseLayer(driver)))
  )

  expect(rows[0]?.posts).toHaveLength(1)
  expect(rows[1]?.posts).toEqual([])
  expect(driver.calls).toHaveLength(2)
  expect(driver.calls[1]?.params).toEqual(["u1", "u2"])
})
```

The query-builder benchmark includes a flat users/posts join, but Thor currently
has no dedicated relation-planner benchmark. Treat query count as an invariant,
not a latency claim; benchmark join expansion, batching, decoding, and database
I/O with application data before choosing a strategy for a hot path.

## Stability

The relation surface is `@experimental`: it is shipped and usable, but names,
types, and planner behavior may change in a minor release. Pin an appropriate
Thor version and keep relation access behind an application boundary when API
stability is important. The underlying safety invariant remains explicit: Thor
does not perform hidden per-parent loading.
