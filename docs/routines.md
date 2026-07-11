# Declared routines

Thor routine descriptors are executable declarations: names are parsed into
quoted identifiers, arguments are bound separately, capability requirements
flow through Query IR, and declared return codecs participate in row decoding.

The current routine surface is partial. Argument declarations currently retain
metadata but do not enforce their codecs or exact shapes; literal arguments use
the general query-value path. True SQL named/default arguments, overload
selection, OUT/INOUT parameters, procedure result decoding, extension
verification, and routine introspection are not implemented.

## Functions

```ts
import { Schema } from "effect"
import { defineFunction } from "@gilvandovieira/thor/routine"

const lower = defineFunction("lower", {
  args: [{ dataType: "text", codec: Schema.String }],
  returns: { dataType: "text", codec: Schema.String },
  volatility: "immutable"
})

db.select({ email: lower(users.email) }).from(users)
```

`defineAggregateFunction` creates the same callable descriptor with aggregate
scope semantics. Ordinary selected columns must then appear in `groupBy`.
Declared function calls require `routine.functionCall`; unsupported dialects
fail before the driver. A selected routine result that does not satisfy its
return codec fails with `DecodeError`.

## Table-Valued Functions

```ts
const series = defineTableFunction("public.generate_series", {
  args: {
    start: { dataType: "integer", codec: Schema.Number },
    stop: { dataType: "integer", codec: Schema.Number }
  },
  returns: {
    value: { dataType: "integer", codec: Schema.Number }
  }
})

const source = series.call({ start: 1, stop: 10 }, "series")
db.select({ value: source.field("value") }).from(source)
```

Returned fields retain their declared codecs. Table-valued sources require
`routine.tableValuedFunction` and can also be passed to join methods.

## Procedures

```ts
const cleanup = defineProcedure("maintenance.cleanup", {
  args: {
    before: { dataType: "text", codec: Schema.String }
  },
  effects: {
    mutates: ["sessions"],
    idempotency: "idempotent",
    requiresTransaction: false
  }
})

const call = cleanup.call({ before: "2026-01-01" })
call.toSql(MySQLDialect)
yield* call.run()
```

Procedure calls are inspectable commands with normal parameter binding and
`routine.procedureCall` capability enforcement. They do not bypass the guard,
compiler, execution, or error pipeline.

`requiresTransaction` is enforced before driver execution. Volatility,
idempotency, mutation lists, and required-extension names are retained as
metadata, but only transaction requirements currently affect execution policy;
they do not yet control preparation or transaction retries.

Basic routine DDL exists as explicit migration-plan operations for PostgreSQL
and MySQL, with SQLite rejected. It is not generated from schema code, does not
cover advanced argument modes/defaults/overloads, and is not routine
introspection.
