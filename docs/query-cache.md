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
| `prepared` | compiled-shape cache key | server-side prepared-statement identity |
| `decoder` | selection shape | row decoder |
| `capability` | IR + capability matrix version | guard result |

The non-prepared execution path (`.all()`/`.one()`/`.run()` against a `Database`
layer) routes through these layers; compiled (`.compile()`) and prepared
(`.prepare()`) handles keep their own per-handle caches.

## Default vs bounded caches (§9.3)

By default every layer is **unbounded and GC-friendly** (backed by a `WeakMap`):
entries live only while their shape key is reachable, so nothing leaks and there
is no eviction. This matches v0 behavior exactly.

Install a **bounded LRU** registry with `withQueryCache` when you want a fixed
memory budget and live cache statistics:

```ts
import { db, withQueryCache } from "@gilvandovieira/thor"

// Standalone layer wrapper …
const Bounded = withQueryCache(PostgresLayer(client), { maxSize: 10_000, strategy: "lru" })

// … or the db-level sugar (identical behavior):
const Bounded2 = db.withQueryCache(PostgresLayer(client), { maxSize: 10_000 })
```

Each layer then retains at most `maxSize` shapes and evicts the
least-recently-used entry. Counters are available for observability (feeds
Epic S):

```ts
for (const layer of db.queryCache.stats()) {
  // { name, hits, misses, evictions, size, maxSize }
}
```

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
