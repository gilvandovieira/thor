# Query cache and precompilation modes

Thor memoizes the hot path so a query executed N times pays its compile, guard,
and decoder cost once. v1 formalizes that memoization into **five named cache
layers** and adds explicit safety/performance modes. Everything here is keyed by
query *shape* — never by parameter values (spec §9.2).

## The five cache layers (§9.1)

| Layer | Key (shape) | Value |
|---|---|---|
| `shape` | Query IR identity | normalized IR |
| `compile` | normalized IR + dialect | compiled SQL |
| `prepared` | physical connection + compiled-shape key | client/server prepared resource |
| `decoder` | selection shape | row decoder |
| `capability` | IR + capability matrix version | guard result |

The non-prepared execution path (`.all()`/`.one()`/`.run()` against a `Database`
layer) routes through these layers; compiled (`.compile()`) and prepared
(`.prepare()`) handles keep their own per-handle caches.

## Default vs bounded caches (§9.3)

By default the shape/compile/decoder/capability layers are unbounded and
GC-friendly (`WeakMap`). Prepared resources are different: they belong to a
physical connection and live until eviction or connection disposal.

Install a **bounded LRU** registry with `withQueryCache` when you want a fixed
shape-cache memory budget and live cache statistics:

```ts
import { db, withQueryCache } from "@gilvandovieira/thor"

// Standalone layer wrapper …
const Bounded = withQueryCache(PostgresLayer(client), {
  maxSize: 10_000,
  preparedMaxSize: 100,
  strategy: "lru"
})

// … or the db-level sugar (identical behavior):
const Bounded2 = db.withQueryCache(PostgresLayer(client), { maxSize: 10_000 })
```

Each shape layer then retains at most `maxSize` shapes and evicts the
least-recently-used entry. Cache-layer registries and counters are internal;
applications should consume supported query observability events instead of
depending on cache implementation objects.

Prepared admission has an independent `preparedMaxSize` bound per physical
connection. It defaults conservatively to 100 whether or not shape-cache
`maxSize` is configured, so client/server prepared registries are bounded without
changing the default GC-friendly shape caches. SQLite and mysql2 release an
evicted statement through their runtime APIs. A driver that
cannot safely deallocate and recreate through its public client contract stops
admitting new prepared shapes at the bound and executes them unprepared. Owned
scoped SQLite/MySQL layers clear all retained statements before releasing the
connection. Separate physical connections always have separate registries.

These are distinct resources: the compile cache retains SQL text; the prepared
observation counters report real connection-registry outcomes; the client cache
owns statement handles; and a database server may own parsed statement state.

## Precompilation modes (§9.4)

Compiled handles expose three precompilation entry points:

```ts
const q = db.select({ id: users.id }).from(users)
  .where(eq(users.email, param("email", Schema.String))).one()

q.compile()             // validate + compile the shape
q.compilePrepared()     // + force server-side prepared reuse
q.compileUnsafeHot()    // + skip decode (explicit opt-in, spec §10.3)
```

`compile()` also accepts per-compile options:

```ts
q.compile(PostgresDialect, { prepare: true, cache: true })
```

- `prepare` — force server-side prepared-statement reuse on/off, overriding the
  service policy.
- `cache` — record prepared-reuse counters for this handle's executions
  (default `true`).
- `mode` — override the execution mode (`safe` | `trusted` | `unsafe-hot`).

`compileUnsafeHot()` never bypasses capability guards: an unsupported feature
(e.g. `RETURNING` on MySQL) still fails at compile time.

## Safety and performance modes (§10)

`withMode` (and `db.withMode`) selects how much runtime work Thor does around the
same compiled SQL. The query API shape is unchanged across modes.

| Mode | Guards | Decode | When |
|---|---|---|---|
| `safe` (default) | full | strict | always correct, best diagnostics |
| `trusted` | reused when a prior pass is recorded | strict | validated hot paths |
| `unsafe-hot` | reused when a prior pass is recorded | **skipped** | precompiled hot paths, explicit opt-in |

```ts
const HotPath = db.withMode(PostgresLayer(client), "trusted")
const Untyped = db.withMode(PostgresLayer(client), "unsafe-hot") // skips decode — opt-in
```

`unsafe-hot` is never a default and must be requested explicitly. The v0 name
`unsafe` remains a deprecated alias, normalized to `unsafe-hot`. Capability
checks are never bypassed without a recorded prior pass (spec §15.17).

## Benchmarks

`pnpm bench:cache` measures the cold / warm / prepared paths against a zero-I/O
driver and prints per-layer hit/miss/eviction counters, including a bounded-LRU
demonstration.
