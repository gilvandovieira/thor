---
name: thor-routines
description: "Use declared functions, aggregates, table functions, and procedures."
---

# Thor Skill: Routines

## Goal

Teach an agent that functions are expressions and procedures are Effect operations, with volatility, transaction, and safety metadata honored.

## Use When

- The user calls database functions, aggregates, window functions, table functions, or stored procedures.

## Required Checks

- `defineFunction`/`defineAggregateFunction` produce expressions usable in select/where; apply windows with `.over({ partitionBy, orderBy })`.
- `defineTableFunction(...).call(args, alias)` is a relation source for `from`.
- `defineProcedure(...).call(args).run()` is an Effect; a `requiresTransaction` procedure fails outside `db.transaction`.
- Routine names are declared and interned; never interpolated.
- Declare volatility so prepared-statement/retry behavior is correct.

## Safe Patterns

- `db.select({ total: sumScore(users.score).over({ partitionBy: [users.teamId] }) }).from(users)`
- `db.transaction(cleanup.call({ before }).run())` for a `requiresTransaction` procedure.

## Unsafe Patterns

- Building a routine name from user input.
- Calling a `requiresTransaction` procedure outside a transaction.
- Treating a procedure like a scalar function (or vice versa).

## Examples

```ts
const lower = defineFunction("lower", { args: [{ dataType: "text", codec: Schema.String }], returns: { dataType: "text", codec: Schema.String }, volatility: "immutable" })
db.select({ email: lower(users.email) }).from(users)
```

## Verification

- Snapshot routine-call SQL and required capabilities.
- Test aggregation-scope and window guards.
- Test procedure transaction-requirement failures.

## Hard Rule

Functions are expressions. Procedures are Effect operations. Do not collapse them into the same API.
