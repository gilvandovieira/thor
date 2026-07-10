# Compiled queries

`CompiledQuery` is Thor's stable hot-path API. It freezes a terminal query into
a validated dialect-specific shape while keeping every user value outside the
handle.

```ts
import { Schema } from "effect"
import { db, eq, param } from "@gilvandovieira/thor"

const FindUserByEmail = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .one()
  .compile()

const user = yield* FindUserByEmail.execute({
  email: "lucas@example.com"
})
```

The default compile target is PostgreSQL. Pass `SQLiteDialect` or
`MySQLDialect` to `compile(dialect)` when targeting another backend. Execution
requires a `Database` layer with the same dialect id and capability-profile hash
used at compile time; a mismatch fails before parameter binding or driver I/O.

## Stable surface

The following v1 compiled-query API is `@stable`:

- `CompiledQuery<Params, Output, Error, Requirements, Dialect, Cardinality>`
- terminal `.compile(dialect?)`
- `CompiledQuery.execute(params)`
- `cacheKey`, `dialect`, `cardinality`, and `capabilities`

Terminals without named parameters remain ordinary Effects, so existing direct
execution still works:

```ts
const rows = yield* db.select({ id: users.id }).from(users).all()
```

For a parameterized terminal, omitting the arguments selects compilation rather
than direct execution. Values are supplied only to the resulting handle:

```ts
const FindMany = db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .all()
  .compile()

const rows = yield* FindMany.execute({ email: "a@example.com" })
```

## Invariants

- Compilation snapshots and normalizes the IR, runs structural and capability
  guards, compiles SQL once, and constructs the decoder and parameter plans.
- `cacheKey` and SQL depend on dialect profile and query structure, never bound
  values.
- `execute` performs only dialect-profile/capability validation, parameter
  validation and encoding, prepared lookup, driver execution, mode-aware decode,
  and cardinality refinement.
- Inline values are rejected during compilation. Use `param(name, schema)` and
  pass each value to `execute`.

`.prepare(name)` remains available as the v0 named multi-dialect handle. Use
`.compile(dialect)` when a stable public handle bound to one known dialect is the
desired hot-path boundary.
