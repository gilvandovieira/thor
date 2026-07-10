# @gilvandovieira/thor

Effect-native TypeScript database toolkit with immutable query IR, typed
parameters, capability-aware SQL compilation, safe decoding, migrations, and
PostgreSQL, SQLite, and MySQL adapters.

The `@stable` compiled-query API validates and lowers a terminal query once,
then binds values separately on every execution:

```ts
const FindUser = db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .one()
  .compile()

const user = yield* FindUser.execute({ email })
```

Node.js 22 or newer is supported. `effect` 3.21 or newer is a peer dependency.
See the [repository README](https://github.com/gilvandovieira/thor#readme) for
installation, examples, support status, and lifecycle guidance.
