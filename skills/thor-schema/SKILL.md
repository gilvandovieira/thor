---
name: thor-schema
description: "Define Thor schemas safely."
---

# Thor Skill: Defining Schemas

## Goal

Teach an agent to declare tables, columns, keys, and constraints with Thor's schema DSL so row types and migration DDL are inferred, not hand-written.

## Use When

- The user models tables, columns, or relationships.
- The user needs Select/Insert/Update row types.
- The user adds foreign keys, indexes, or unique/generated columns.

## Required Checks

- Use `pg`/`sqlite`/`mysql` table builders; never hand-write row interfaces.
- Mark nullability with `.notNull()`/`.nullable()`; defaults with `.default*()`.
- Declare foreign keys with `column.references(() => other.col)` (deferred thunk; annotate self-references).
- Declare indexes/unique/check via table options; they flow into migration DDL.
- Check dialect capabilities before using generated columns or advanced types.

## Safe Patterns

- `pg.uuid("id").primaryKey().defaultRandom()`
- `pg.text("email").notNull().unique()`
- `authorId: pg.uuid("author_id").notNull().references(() => authors.id, { onDelete: "cascade" })`
- Derive types: `type Row = Select<typeof table>`.

## Unsafe Patterns

- Hand-writing TS interfaces that duplicate the table shape.
- Adding dialect-specific column types without a capability check.
- Interpolating identifiers into names instead of using the DSL.

## Examples

```ts
const authors = pg.table("authors", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  name: pg.text("name").notNull()
})
const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  authorId: pg.uuid("author_id").notNull().references(() => authors.id),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})
```

## Verification

- Add compile-time type tests for `Select`/`Insert`/`Update`.
- Snapshot the `tableToCreateOp` DDL per dialect.
- Round-trip FK/index metadata through migration + introspection.

## Hard Rule

Do not create schema constructs without checking dialect capabilities.
