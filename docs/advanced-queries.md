# Advanced queries

Epic J extends the immutable query IR and fluent builder with joins, subqueries,
aggregation, CTEs, windows, set operations, and dialect-aware upserts. Every
feature uses the existing normalize, guard, capability, compile, bind, execute,
and decode pipeline.

## Aliases and joins

```ts
const author = alias(users, "author")
const editor = alias(users, "editor")

const query = db
  .select({ author: author.email, editor: editor.email })
  .from(author)
  .leftJoin(editor, eq(author.editorId, editor.id))
```

Select queries expose `join`, `innerJoin`, `leftJoin`, `rightJoin`, `fullJoin`,
`crossJoin`, and `lateralJoin`. Scope guards validate each join predicate using
only relations visible at that point. Right, full, and lateral joins carry
explicit capability requirements.

## Subqueries

Use `.as(name)` for a derived table and `.field(name)` for its selected outputs:

```ts
const recent = db.select({ userId: posts.userId }).from(posts).as("recent")

db.select({ userId: recent.field("userId") }).from(recent)
```

`scalar`, `exists`, `notExists`, `inSubquery`, and `notInSubquery` embed select
queries in expressions. Expression subqueries may correlate with their outer
query. Derived tables may correlate only when added with `lateralJoin`.

## Aggregation and windows

```ts
db.select({
  email: users.email,
  total: count(),
  position: rowNumber().over({
    partitionBy: [users.teamId],
    orderBy: [desc(users.createdAt)]
  })
})
  .from(users)
  .groupBy(users.email)
  .having(gt(count(), 0))
```

The aggregate helpers are `count`, `sum`, `avg`, `min`, and `max`. A grouped or
aggregate query fails the `aggregation-scope` guard when a selected ordinary
column is missing from `groupBy`. `distinct()` applies standard row-level
distinctness. Window expressions require `select.windowFunctions`.

## CTEs and sets

```ts
const active = db.cte(
  "active_users",
  db.select({ id: users.id }).from(users).where(eq(users.active, true))
)

const activeIds = db.select({ id: active.field("id") }).from(active)
const archivedIds = db.select({ id: archivedUsers.id }).from(archivedUsers)

activeIds.unionAll(archivedIds)
```

`db.cte` and `db.recursiveCte` attach named definitions automatically when used
as a source. `union`, `unionAll`, `intersect`, and `except` validate selection
width and require `select.setOperations`.

## Upserts

PostgreSQL and SQLite use conflict policies:

```ts
db.insert(users)
  .values({ email })
  .onConflictDoUpdate([users.email], { name: excluded(users.name) })
```

MySQL uses its native policy:

```ts
db.insert(users)
  .values({ email })
  .onDuplicateKeyUpdate({ name: excluded(users.name) })
```

`excluded(column)` renders as `EXCLUDED.column` for PostgreSQL/SQLite and as the
MySQL candidate-value expression inside `ON DUPLICATE KEY UPDATE`. Using either
policy on an unsupported dialect fails with `CapabilityError` before the driver.
