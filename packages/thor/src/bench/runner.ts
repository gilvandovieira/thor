/**
 * Minimal benchmark harness (spec §15). Measures a synchronous hot path and
 * reports ops/sec — enough to catch regressions in build/IR/compile cost.
 *
 * @module bench/runner
 */
import { performance } from "node:perf_hooks"
/** Normalized timing and throughput statistics for one benchmark. */
export interface BenchResult {
  readonly name: string
  readonly iterations: number
  readonly totalMs: number
  readonly opsPerSec: number
  readonly nsPerOp: number
}

/**
 * Measures a synchronous function after a bounded warmup.
 *
 * @param name - Human-readable benchmark name.
 * @param fn - Synchronous operation to measure.
 * @param iterations - Number of timed calls; defaults to 100,000.
 * @returns Timing and throughput statistics.
 */
export const bench = (name: string, fn: () => void, iterations = 100_000): BenchResult => {
  for (let i = 0; i < Math.min(iterations, 1_000); i++) fn() // warmup
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const totalMs = performance.now() - start
  return {
    name,
    iterations,
    totalMs,
    opsPerSec: Math.round((iterations / totalMs) * 1000),
    nsPerOp: (totalMs * 1e6) / iterations
  }
}

/**
 * @param r - Benchmark statistics.
 * @returns Fixed-width human-readable result line.

 */
export const formatResult = (r: BenchResult): string =>
  `${r.name.padEnd(28)} ${r.opsPerSec.toLocaleString().padStart(14)} ops/s   ${r.nsPerOp.toFixed(1).padStart(8)} ns/op`
