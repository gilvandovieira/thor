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
  readonly fastestNsPerOp: number
  readonly slowestNsPerOp: number
  readonly p95NsPerOp: number
  readonly sampleCount: number
}

const sampleCount = 5

/**
 * @param sorted - Timing samples sorted from fastest to slowest.
 * @returns The middle value, or the mean of the middle pair.
 */
const median = (sorted: ReadonlyArray<number>): number => {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/**
 * @param ns - Duration in nanoseconds.
 * @returns A compact duration suitable for benchmark output.
 */
const formatDuration = (ns: number): string => {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`
  if (ns < 1e6) return `${(ns / 1_000).toFixed(ns < 10_000 ? 2 : 1)} µs`
  return `${(ns / 1e6).toFixed(2)} ms`
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
  const iterationsPerSample = Math.max(1, Math.floor(iterations / sampleCount))
  const samples: number[] = []
  let totalMs = 0
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now()
    for (let i = 0; i < iterationsPerSample; i++) fn()
    const elapsedMs = performance.now() - start
    totalMs += elapsedMs
    samples.push((elapsedMs * 1e6) / iterationsPerSample)
  }
  const sorted = samples.sort((a, b) => a - b)
  const nsPerOp = median(sorted)
  return {
    name,
    iterations: iterationsPerSample * sampleCount,
    totalMs,
    opsPerSec: Math.round(1e9 / nsPerOp),
    nsPerOp,
    fastestNsPerOp: sorted[0]!,
    slowestNsPerOp: sorted[sorted.length - 1]!,
    p95NsPerOp: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    sampleCount
  }
}

/**
 * @param r - Benchmark statistics.
 * @returns Fixed-width human-readable result line.

 */
export const formatResult = (r: BenchResult): string =>
  `${r.name.padEnd(28)} ${formatDuration(r.nsPerOp).padStart(10)} typical   ${`${formatDuration(r.fastestNsPerOp)}–${formatDuration(r.slowestNsPerOp)}`.padStart(19)} range   ${r.opsPerSec.toLocaleString().padStart(12)} ops/s equivalent`
