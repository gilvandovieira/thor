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

Database layers can opt into Effect spans, metrics, structured events, and safe
logging with `db.withObservability(...)`. SQL and parameter values are omitted by
default; raw values require an explicit `unsafe-full` mode. See the
[observability guide](https://github.com/gilvandovieira/thor/blob/main/docs/observability.md).

Additional public subpaths include:

- [`/relations`](https://github.com/gilvandovieira/thor/blob/main/docs/relations.md) for explicit typed relation graphs and loading strategies;
- [`/introspect`](https://github.com/gilvandovieira/thor/blob/main/docs/introspection.md) for live Schema IR and structural drift;
- [`/skills`](https://github.com/gilvandovieira/thor/blob/main/docs/skills.md) for deterministic LLM guidance rendering;
- `/migrate`, `/capabilities`, `/testing`, and `/routine` for their respective advanced workflows.

Compatibility levels are documented in the
[API stability guide](https://github.com/gilvandovieira/thor/blob/main/docs/api-stability.md),
and the frozen tagged failures are listed in the
[error guide](https://github.com/gilvandovieira/thor/blob/main/docs/errors.md).

Node.js 22 or newer is supported. `effect` 3.21 or newer is a peer dependency.
See the [repository README](https://github.com/gilvandovieira/thor#readme) for
installation, examples, dialect support boundaries, and lifecycle guidance.
