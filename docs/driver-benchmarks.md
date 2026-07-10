# Driver benchmarks: prepared, unprepared, and static-handle paths

## The 30-second version

- **Look at time first; smaller is better.** `1 ms` is one thousandth of a
  second. `1 µs` is one millionth of a second.
- **“Typical” is the middle result from five samples.** One lucky or unlucky
  timing pass no longer becomes the headline number.
- **Check the range.** If two results overlap or the run says `noisy`, rerun it
  before claiming a win. A tiny difference inside the range is not meaningful.
- **`ops/s` is an equivalent, not a promise.** It answers “how many could fit in
  one second if this were the only work?” It is not production capacity.
- **Use the benchmark that matches the question.** `bench:hotpath` measures Thor
  alone, `bench:sqlite` makes library overhead easy to see, and `bench:e2e`
  includes a real local PostgreSQL server.

The executable reports end with an **“In everyday terms”** summary and retain a
`JSON:` line for tools. Absolute numbers vary by computer; comparisons made in
the same run are usually more useful.

> **Scope and caveat:** cross-driver throughput below compares the two Postgres
> adapters. The historical postgres.js write advantage is an **unprepared-path**
> result; the adapters converge when preparation is enabled. SQLite is measured
> separately as an in-process stress test. MySQL is **tested** (it passes the
> shared capability-aware contract suite and the SQL feature-matrix integration
> against real MySQL 8.4 via `pnpm e2e`) but is **not yet benchmarked** — no
> recorded MySQL driver-comparison numbers.

Thor runs the same dialect (Postgres) behind interchangeable **driver adapters**.
These notes record (1) what Thor does about prepared statements, and (2) the
independent, measured performance of each driver with and without them — so we
can tell whether the driver seam, Thor's abstraction, or missed preparation
costs anything.

## What Thor does about prepared statements (spec §16)

The compiler emits a `CompiledQuery { sql, paramOrder, cacheKey }` where
`cacheKey` is a **stable, value-independent** hash of the SQL shape. Execution
uses it as the prepared-statement identity:

- **Parameterized statements** (`paramOrder.length > 0`) are executed with the
  `cacheKey` as the prepared-statement name, so identical shapes are parsed once
  and reused on later calls (bound values travel separately).
- **Param-free statements** are never prepared — they may be multi-statement DDL
  (migrations), which cannot be prepared and must use the simple protocol.
- The behavior is a `Database` flag, `preparedStatements` (default **on**);
  `PostgresLayer(client, { preparedStatements: false })` disables it.

Server-side statement preparation and Thor's static query handles are related
but distinct. Fluent queries already reuse server-side prepared statements by
shape. For a static query executed repeatedly, `.prepare("name")` is the intended
hot path: it additionally snapshots normalized IR and precomputes the guard,
parameter order, structural hash, decoder plan, and per-dialect compilation.

Per adapter:

| Adapter | How preparation is requested | Collision safety |
|---|---|---|
| node-postgres | named statement: `query({ text, values, name: cacheKey })` | pg caches by `name` and ignores `text` on reuse, so a 32-bit `cacheKey` collision could run the wrong statement. The adapter keeps a `name → text` map and **falls back to an unnamed query** on any mismatch. |
| postgres.js | `unsafe(sql, params, { prepare: true })` | postgres.js keys its prepared cache by the **query text**, so it is collision-safe by construction. |

> Before this work, `cacheKey` was computed and thrown away: node-postgres ran
> unnamed (re-parsed every call) and postgres.js `unsafe` did not prepare. The
> benchmark below is exactly the "off vs on" of fixing that.

## Benchmark method

- Script: [`packages/thor/scripts/bench-drivers.mts`](../packages/thor/scripts/bench-drivers.mts) — `pnpm bench:e2e`.
- `postgres:17-alpine` in Docker, `tmpfs` storage, over localhost (network ≈ 0).
- Each (driver × mode) runs on its **own fresh single connection**, re-seeded to
  1 point row + 200 bulk rows, so prepared-statement caches never leak across runs.
- Read scenarios run before writes, and the bulk query has an explicit 200-row
  limit. Inserts can no longer silently turn `select.bulk200` into a much larger
  workload.
- Per scenario: 30-iteration warmup (registers the prepared statement), then
  five timed samples. The report uses their median and shows the full range.
- **Not a production benchmark** — see caveats.

Scenarios: `insert`, `insert.returning` (decode 1 row), `select.point` (unique-key
lookup with a bound param), `select.bulk200` (param-free, decode 200 rows),
`update.point` (single-row update by key).

## Prepared statements: OFF vs ON (per driver)

> **Recorded snapshot:** Node 26.4, PG 17 (Docker, `tmpfs`, loopback). These
> historical tables use `ops/s` (bigger = faster). Current executable output
> leads with median latency (smaller = faster) and prints its sample range.

Speedup = ops/s with preparation ÷ ops/s without:

**node-postgres** (prepared ON, ops/s)

| Scenario | off | on | speedup |
|---|--:|--:|--:|
| insert | 3,615 | 5,383 | 1.49× |
| insert.returning | 3,698 | 6,519 | 1.76× |
| select.point | 3,685 | 5,197 | 1.41× |
| update.point | 6,289 | 8,321 | 1.32× |
| select.bulk200 *(param-free)* | 743 | 707 | ~1.0× |

**postgres.js** (prepared ON, ops/s)

| Scenario | off | on | speedup |
|---|--:|--:|--:|
| insert | 4,223 | 7,442 | 1.76× |
| insert.returning | 4,381 | 6,296 | 1.44× |
| select.point | 3,556 | 5,222 | 1.47× |
| update.point | 5,445 | 7,781 | 1.43× |
| select.bulk200 *(param-free)* | 741 | 692 | ~1.0× |

## Driver comparison (prepared ON)

Ratio = node-postgres ÷ postgres.js, ops/s (≈1.0× = even):

| Scenario | ratio | reading |
|---|--:|---|
| insert | 0.72× | postgres.js ahead |
| insert.returning | 1.04× | even |
| select.point | 1.00× | even |
| update.point | 1.07× | even |
| select.bulk200 | 1.02× | even (driver-independent) |

Absolute throughput with preparation on: single-row ops land at **~5,200–8,300
ops/s** (~0.12–0.19 ms/op); the 200-row decode at **~700 ops/s** (~1.4 ms/op).

## Takeaways

1. **Preparation is a real, free win for repeated shapes.** Parameterized
   single-row workloads gain **1.1–2.3×** once the shape is prepared and reused —
   the largest gains on `insert`/`select.point`, the workloads dominated by
   parse cost per round-trip. This is `cacheKey` finally doing its job (spec §16).
2. **Param-free stays honest.** `select.bulk200` is ~1.0× in both modes — Thor
   never prepares param-free statements, and the benchmark confirms it. Bulk time
   is decode + wire, not parse.
3. **With preparation on, the drivers converge.** The earlier cross-driver gap
   (postgres.js ahead on writes) was largely *automatic-vs-none* preparation.
   Once both prepare, node-postgres and postgres.js are within noise (0.9–1.1×).
   **Pick a driver on operational grounds, not raw speed.**
4. **Thor is not the bottleneck.** Both drivers, both modes, sit in the same
   order of magnitude; differences trace to parse-reuse and the client, not the
   builder/IR/compile/decode path (guiding invariant §15.1).
5. **Decode is the next hot path.** ~4.6 ms for 200 rows vs ~0.15 ms for one row
   is Effect-Schema decode + row materialization — a good target for the decode
   benchmarks (spec §15.8), and independent of the driver.

## Caveats

- **Not a production benchmark.** Single machine, single connection, loopback
  (no real network latency), `tmpfs` storage. Absolute numbers change a lot under
  real network + disk + concurrency.
- **No pooling.** One connection per driver so transactions/locks behave
  identically; prepared statements are per-connection, and a pool changes both
  throughput and prepared-statement hit rates.
- **Microbenchmark noise.** Run-to-run variance is ±15–20% (see the speedup
  *ranges*). Treat the direction and rough magnitude, not a single number, as the
  signal.
- **DDL invalidates prepared statements.** Dropping/altering a referenced table
  invalidates cached plans; the benchmark isolates this by using a fresh
  connection per mode.

## Own-code overhead (how much does *Thor* cost, minus I/O?)

`scripts/bench-overhead.mts` (`pnpm bench:overhead`) times each pipeline stage
and the full execution against a **constant in-memory driver** (zero I/O), through
a **shared runtime** (as in a real program, not a fresh fiber per call).

Latest run (Node 26.4) — smaller = faster:

| Stage | µs per op | notes |
|---|--:|---|
| build (construct query IR) | **~0.42 µs** | sub-µs |
| compile → SQL + params | **~0.64 µs** | memoized per shape after first call |
| guard (scope + capability) | **~0.58 µs** | memoized per shape after first call |
| decode (precompiled) | **~0.26 µs/row** | one compiled decoder per selection |
| Effect run floor | ~0.05 µs | shared-runtime `runSync` |
| **execute point `.one()`** | **~3.2 µs** | full path: guard→compile→bind→drive→decode→cardinality→Effect |
| execute bulk `.all()` (100 rows) | ~35 µs | ~0.35 µs/row |

For a real prepared point-select (~150 µs loopback), **Thor's own code is ~2%**
of the round-trip; over a real network it's a fraction of a percent.

### What we fixed (the numbers above are *after*)

Two hot-path defects, found by this benchmark:

1. **Decode recompiled the parser per field, per row.** `Schema.decodeUnknown`
   was called inside a `forEach` over fields inside a `forEach` over rows — 400
   parser derivations for 100×4. Now a **single row decoder is compiled once and
   cached** (WeakMap keyed by the selection), decoding in a tight sync loop.
   → bulk decode **3.75 → 0.28 µs/row (~12×)**.
2. **Every execution recompiled SQL and re-ran guards.** Both are pure functions
   of `(IR, dialect)`, so they're now **memoized per query shape**; a query run N
   times with different values pays compile + guard once.
   → point `.one()` **~30.8 → ~3.1 µs (~10×)**.

### On the "1–2 µs for everything" target

The pure stages hit it: build/compile/guard are 0.28–1.2 µs, decode is
0.28 µs/row. The full `.one()` sits at ~3.1 µs — of which the pure work is now
<1 µs; the remaining ~2.7 µs is **Effect's typed/resource-safe runtime** for the
~5-step pipeline (`Effect run floor` shows a bare run is ~0.04 µs, so it's the
combinators, not `runSync`). That floor is the deliberate architectural cost of
Effect at the execution boundary (spec §18.10) — pushing `.one()` below it would
mean bypassing Effect on the hot path, which the design explicitly rejects. At
~2% of a real query it is not worth it.

> **These table values remain pre-handle historical numbers.** Precompiled static
> handles (`.prepare("name")`, §15.15) and safe/trusted/unsafe performance modes
> (§15.13) are implemented. The direct fluent-versus-handle and mode measurements
> appear in [Hot-path axes & staged regression gate](#hot-path-axes--staged-regression-gate-benchhotpath); the
> older measurements above have not been relabeled as handle results.

### The fast-DB stress test: in-memory SQLite

`scripts/bench-sqlite.mts` (`pnpm bench:sqlite`, no Docker) runs Thor over
**in-memory `node:sqlite`** — synchronous, in-process, so a query is a
*microsecond*. There's no network or disk to hide behind, so this is the honest
worst case for an abstraction. Per op:

Latest run (Node 26.4) — raw/overhead in µs (smaller = faster); share = Thor's
slice of the total (smaller = thinner layer):

| Scenario | raw `node:sqlite` | Thor (prep off) | Thor (prep on) | Thor overhead | Thor share |
|---|--:|--:|--:|--:|--:|
| select.point | ~0.63 µs | ~7.2 µs | **~3.8 µs** | ~3.2 µs | **~84%** |
| select.bulk200 | ~52 µs | ~102 µs | ~103 µs | ~52 µs (~0.26 µs/row) | ~50% |

This hits home three things:

- **When the DB is basically free, Thor *is* most of the time** (~82% of a point
  select). That's expected — and it's exactly why the decode + compile/guard
  memoization matter. Without them this number would be ~95%+ and the absolute
  latency 5–10× worse.
- **Preparation matters even in-process:** point select is **1.9× faster** with
  prepared statements on, because otherwise `node:sqlite` re-`prepare()`s every
  call. (Bulk is param-free, so it is never prepared — its overhead is
  re-prepare + decode, ~0.27 µs/row, about the same as SQLite's own row cost.)
- **The same few µs is noise over a network DB.** Over Postgres (~150 µs) Thor is
  <2%; over in-memory SQLite it's ~82%. Same Thor, different denominator — so
  "how much does our code cost" is best answered in absolute µs (~3–4 µs/query),
  not as a percentage.

### Runtime: Node vs Bun

Both own-code benchmarks run under Node (`node:sqlite`) and Bun (`bun:sqlite`) —
the SQLite bench selects the runtime's driver via a variable dynamic import.
`pnpm bench:overhead:bun` / `pnpm bench:sqlite:bun` run them under Bun.

Reviewed W2 run on Linux x64 (Node 26.4, Bun 1.3.14) — µs, smaller = faster:

| Metric | Node 26.4 | Bun 1.3 |
|---|--:|--:|
| raw constant-driver Effect | 0.10 µs | 0.14 µs |
| minimal object construction | 0.01 µs | <0.01 µs |
| `point.cold` (rebuilt each call) | 39.1 µs | 23.1 µs |
| `point.warm` (stable query caches) | 4.39 µs | 3.66 µs |
| `point.compiled` | 3.89 µs | 3.28 µs |
| `point.compiledPrepared` | 3.81 µs | 3.45 µs |
| `point.unsafeHot` | 3.74 µs | 3.00 µs |
| decode (precompiled) | ~0.26 µs/row | ~0.17 µs/row |
| SQLite point select, Thor prepared on | ~3.8 µs | ~3.4 µs |
| raw in-memory SQLite point select | ~0.63 µs | ~0.44 µs |

Bun is ~30–40% faster on the hot loops (JavaScriptCore + native SQLite); the
shape is identical, so pick the runtime on operational grounds.

Bun is a bit faster on the decode loop and SQLite (JavaScriptCore + its native
SQLite), but the shape is identical: Thor's own code is a few µs, dominated by
the Effect runtime, and ~85% of a microsecond-fast query on both runtimes.

### Independent v1 stage matrix (`bench:stages`)

W1 separates the in-memory pipeline instead of presenting one "ORM benchmark"
number. `pnpm bench:build`, `bench:ir`, `bench:compile`, `bench:decode`, and
`bench:effect` each time one boundary. `pnpm bench:cache` retains the dedicated
cold/warm/prepared cache report. `pnpm bench:runtime-node` and
`bench:runtime-bun` execute the identical stage matrix under each runtime.

Every stage command prints median/range/throughput plus a final structured
`JSON:` line. These measurements exclude database, disk, network, and native
driver time.

## Hot-path axes & staged regression gate (`bench:hotpath`)

`scripts/bench-hotpath.mts` isolates raw/minimal floors, cache memoization,
legacy `.prepare()`, stable compiled handles, and execution modes against a
constant no-op driver + shared runtime. The full reviewed values live in
`scripts/hotpath-baselines/{node,bun}-linux-x64.json`.

| Scenario | µs/op | what it isolates |
|---|--:|---|
| `point.cold` | 39.1 µs | query rebuilt every call — compile + guard run each time |
| `point.warm` | 4.39 µs | stable IR reused → compile/guard memoized |
| `point.compiled` | 3.89 µs | stable `.compile()` handle without preparation |
| `point.compiledPrepared` | 3.81 µs | stable `.compilePrepared()` handle |
| `point.unsafeHot` | 3.74 µs | explicit compiled decode-skip path |
| `bulk.safe` (100 rows) | 39.6 µs | strict schema decode of every row |
| `bulk.unsafe` (100 rows) | 3.03 µs | unsafe-hot mode skips decode |

Derived (× faster, bigger = better):
- **cold → warm: ~9× faster** — the gate also requires warm to remain at least 2× faster than cold. ✅
- **warm → compiled: ~1.1× faster** — precompilation removes remaining shape work.
- **bulk safe → unsafe: ~13× faster** — the decode-skip lever, opt-in only.
- `point.warm` = **4.39 µs** currently reports **OVER** against the ≤2 µs warm
  cached target (§19.3). This is tracked honestly as a target, not a release promise.
- `point.compiledPrepared` = **3.81 µs** (Node), **3.45 µs** (Bun) is reported separately
  against a ≤1 µs boundary for the aspirational sub-microsecond smallest-path
  ideal; the residual is largely the Effect runtime floor.
- The join + aggregate handle (`advanced.prepared` ~2.4 µs) stays in the **same
  envelope** as the simple prepared point query — Epic J added no measurable hot-path cost.
- Declared routine execution (`routine.prepared` ~1.63 µs) also stays inside the
  target envelope, including capability lookup and return-codec decoding.

**Stabilized CI gate (§19.6).** `pnpm bench:baseline:node` and
`bench:baseline:bun` record reviewed runtime/platform/architecture files under
`scripts/hotpath-baselines/`. Both CI gates validate the baseline schema,
environment class, sample metadata, and every metric, then fail above **2.25×**
the reviewed median. Metrics below 500 ns remain recorded but are excluded from
multiplicative gating because timer noise dominates them. The gate also requires
warm execution to stay at least 2× faster than cold execution.

Runtime versions are recorded as metadata but are not required to match exactly;
one reviewed file covers the supported runtime versions on the same
runtime/platform/architecture class. Missing baselines never self-create in gate
mode. W3's ≤2 µs target remains informational and separate from this regression
policy.

### Performance contribution checklist (§18.9)

Every new query feature must ship benchmarks. Before merging a
performance-sensitive change:

- [ ] Add/extend a `bench:*` scenario covering **build, IR, compile, capability-check, and execute** cost where applicable.
- [ ] Confirm the compile/guard **cache hit** stays ≫ cold (`bench:hotpath`).
- [ ] Track `point.warm` against the **≤2 µs** target and explain movement; do not
  substitute the faster prepared path for the warm-cache metric.
- [ ] Run `pnpm bench:gate:node` and `pnpm bench:gate:bun`; update either baseline only with a deliberate, reviewed change.
- [ ] Record notable numbers here.

## Reproduce

```sh
pnpm bench:report     # recommended start: all no-Docker reports with plain-language summaries
pnpm bench:e2e        # per-driver, prepared off vs on (real Postgres)
pnpm bench:overhead   # own-code overhead, no database
pnpm bench:sqlite     # Thor vs raw in-memory SQLite (fast-DB stress test)
pnpm bench:hotpath    # cold vs warm vs prepared vs mode axes (no database)
pnpm bench:gate:node  # Node gate against the reviewed machine-class baseline
pnpm bench:gate:bun   # Bun gate against the reviewed machine-class baseline
# or against your own database:
DATABASE_URL=postgres://user:pass@host:5432/db pnpm bench:drivers
```
