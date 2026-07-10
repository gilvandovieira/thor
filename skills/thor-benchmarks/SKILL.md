---
name: thor-benchmarks
description: "Benchmark hot paths before adding abstraction."
---

# Thor Skill: Benchmarks

## Goal

Teach an agent to measure build/IR/compile/decode/effect/cache overhead per runtime before adding abstraction to hot paths.

## Use When

- The user changes the execution pipeline, caches, decoding, or adds a query feature.

## Required Checks

- Measure cold vs warm vs prepared; the warm/prepared path is the target.
- Run Node and Bun lanes (`bench:hotpath`, `bench:hotpath:bun`).
- Watch the cache layers with `bench:cache` (hit/miss/eviction counters).
- New query features add build/IR/compile/cap-check/exec benchmarks.
- Gate with `bench:gate` against a reviewed committed baseline.

## Safe Patterns

- `pnpm bench:hotpath` then `pnpm bench:gate` before/after a change.
- Hoist a `.prepare()`/`.compile()` handle for repeated hot queries.

## Unsafe Patterns

- Adding indirection to the hot path with no benchmark.
- Self-baselining the perf gate.
- Comparing across machines without a matching baseline.

## Examples

```sh
pnpm bench:hotpath   # cold/warm/compiled/unsafe-hot
pnpm bench:cache     # per-layer hit/miss
pnpm bench:gate:node # reviewed Node regression gate
pnpm bench:gate:bun  # reviewed Bun regression gate
```

## Verification

- Record a reviewed baseline per runtime/platform/arch.
- Report warm-path overhead vs the 1–2 µs target.
- Add a per-feature benchmark with each new feature.

## Hard Rule

Do not add abstraction to hot paths without a benchmark.
