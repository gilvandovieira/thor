# Query-builder benchmark: Thor versus Drizzle and Prisma

## Result in plain English

Thor meets the parity goal on this benchmark and currently exceeds it:

- Against Drizzle, Thor used **33–34% of the time** to construct a query and
  generate PostgreSQL SQL—roughly **2.5–3.6× faster** across the measured shapes.
- Against Prisma, Thor used **9–10% of the time** to construct the public query
  object—roughly **10–11× faster** by the geometric mean.

The Prisma number covers only creation of its lazy request. Prisma has no public
offline `toSQL()` equivalent: its query engine and SQL generation run when the
request is awaited. The benchmark reports that boundary as `N/A` instead of
using unsupported internals or pretending that less work is a complete SQL
comparison.

This does **not** mean an application or database will run 3× faster. The saved
work is measured in microseconds and will usually be much smaller than network,
database, decoding, and application time. It establishes that Thor's query
abstraction is at least in Drizzle's performance class and is not adding an
unexpected query-construction tax.

## Recorded comparison

Environment: Node 26.4.0, Linux x64, Drizzle ORM 0.45.2, Prisma ORM 7.8.0. The
benchmark was run in three fresh processes. Each process used five samples of
30,000 operations per toolkit and rotated which toolkit ran first. Values below
summarize the three runs; smaller is faster.

### Public builder/request construction

| Query intent | Thor | Drizzle | Prisma lazy request | Thor / Prisma |
|---|---:|---:|---:|---:|
| Point select | ~0.48–0.53 µs | ~1.2–1.5 µs | ~8.6–9.3 µs | 0.06× |
| Insert returning | ~0.58–0.70 µs | ~0.34–0.39 µs | ~8.9–9.2 µs | 0.06–0.08× |
| Grouped count | ~0.61–0.67 µs | ~1.2–1.3 µs | ~3.8–3.9 µs | 0.16–0.17× |
| Users + posts | ~0.74–0.83 µs | ~1.8–2.0 µs | ~4.1–4.3 µs | 0.18–0.20× |
| Update returning | ~0.52–0.62 µs | ~1.5–1.6 µs | ~9.4–9.7 µs | 0.05–0.07× |

Prisma creates a lazy `PrismaPromise`-style request in this table; it does not
contact PostgreSQL. The users-plus-posts case is analogous rather than
SQL-identical: Thor and Drizzle construct a flat left join, while Prisma creates
a nested relation selection.

### Complete builder plus SQL generation

| Query shape | Thor build + SQL | Drizzle build + SQL | Thor / Drizzle | Reading |
|---|---:|---:|---:|---|
| Point select | ~4.9–5.4 µs | ~14.2–14.6 µs | 0.35–0.37× | Thor ~2.7–2.9× faster |
| Insert returning | ~5.0–5.2 µs | ~15.7–16.4 µs | 0.31–0.33× | Thor ~3.0–3.2× faster |
| Grouped count | ~5.3–5.5 µs | ~13.9–14.3 µs | 0.37–0.39× | Thor ~2.5–2.7× faster |
| Left join | ~6.0–6.6 µs | ~18.8–20.3 µs | 0.30–0.35× | Thor ~2.9–3.4× faster |
| Update returning | ~4.6–4.8 µs | ~16.2–16.6 µs | 0.28–0.29× | Thor ~3.4–3.6× faster |

Prisma is not present in this table because its public client cannot generate
offline SQL. The geometric-mean results were stable across repeated processes:

- Builder construction only: Thor used roughly half of Drizzle's time and
  **9–10%** of Prisma's lazy request-construction time.
- Builder construction plus SQL generation: Thor used **33–34%** of Drizzle's
  time.

Drizzle was faster on one isolated number: constructing an insert builder
without generating SQL. Drizzle defers more work in that path, so the
build-plus-SQL measurement is the more complete comparison. Thor led all five
shapes once both libraries had produced PostgreSQL SQL and parameters.

## What is compared

[`bench-query-builders.mts`](../packages/thor/scripts/bench-query-builders.mts)
uses each library's normal public API with equivalent schemas and query intent:

- point select: two selected columns, named email placeholder, `LIMIT 1`;
- insert: two supplied values and the generated id returned;
- aggregate: email grouping with `count(*)`;
- relation: users left-joined to posts by user id in Thor/Drizzle and the
  analogous nested posts selection in Prisma;
- update: one assigned column, named email placeholder, id returned.

Every shape has two measurements:

1. **Build** constructs the typed builder or lazy Prisma request but does not
   execute it.
2. **Build + SQL** starts from scratch and produces PostgreSQL SQL and parameter
   metadata. This applies only to Thor and Drizzle.

The harness warms both implementations, records medians rather than trusting a
single pass, displays the fastest-to-slowest sample range, alternates execution
order, and keeps results alive so the runtime cannot discard the work. It also
generates one SQL example from every shape before timing; a shape that cannot
produce SQL fails instead of appearing in the table.

## Fairness and limits

- This is a **query-construction microbenchmark**, not an ORM feature comparison
  or production throughput test. It deliberately excludes database I/O.
- SQL is semantically equivalent, not byte-for-byte identical. For example,
  Drizzle binds `LIMIT 1` while Thor emits the literal, and their selected-column
  aliasing differs.
- Builder-only work is not identical internally because each toolkit chooses
  when to normalize or defer work. Prisma explicitly defers its engine work
  until the request is awaited. Build + SQL is the best end-to-end number, and
  it is available only for Thor and Drizzle through supported public APIs.
- Both libraries run in the same process under the same runtime, but garbage
  collection, JIT compilation, CPU scaling, and other machine activity still
  create noise. Use repeated-run ranges, not one lucky number.
- Dependency upgrades can change the result. The recorded comparison names the
  Drizzle and Node versions for that reason.

## Reproduce

```sh
pnpm install
pnpm bench:builders

# Longer run, or inspect the generated SQL used to validate each shape:
BENCH_ITERATIONS=30000 pnpm bench:builders
BENCH_SHOW_SQL=1 pnpm bench:builders
```

`BENCH_SAMPLES` changes the sample count (minimum 3) and `BENCH_ITERATIONS`
changes operations per sample (minimum 1,000). The final `JSON:` line is intended
for scripts and future report generation.
