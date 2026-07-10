/**
 * Shared timing and reporting helpers for Thor's executable benchmarks.
 *
 * A benchmark result is the median of several samples. The fastest and slowest
 * samples remain visible so readers can tell a real signal from a noisy run.
 */
import { performance } from "node:perf_hooks"

const DEFAULT_SAMPLES = 5

/** Repeated timing statistics for one operation. All durations are nanoseconds. */
export interface Timing {
  readonly nsPerOp: number
  readonly fastestNsPerOp: number
  readonly slowestNsPerOp: number
  readonly p95NsPerOp: number
  readonly opsPerSec: number
  readonly sampleCount: number
  readonly iterationsPerSample: number
}

/** Options shared by synchronous and asynchronous measurements. */
export interface TimingOptions {
  readonly iterationsPerSample: number
  readonly warmupIterations?: number
  readonly samples?: number
}

const sampleCount = (requested?: number): number => {
  const fromEnv = Number(process.env.BENCH_SAMPLES)
  const value = requested ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_SAMPLES)
  if (!Number.isInteger(value) || value < 1) throw new Error(`samples must be a positive integer; received ${value}`)
  return value
}

const median = (sorted: ReadonlyArray<number>): number => {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** Converts individual sample timings into the summary used by every report. */
export const summarizeTimings = (values: ReadonlyArray<number>, iterationsPerSample: number): Timing => {
  if (values.length === 0) throw new Error("at least one timing sample is required")
  const sorted = [...values].sort((a, b) => a - b)
  const nsPerOp = median(sorted)
  return {
    nsPerOp,
    fastestNsPerOp: sorted[0]!,
    slowestNsPerOp: sorted[sorted.length - 1]!,
    p95NsPerOp: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    opsPerSec: 1e9 / nsPerOp,
    sampleCount: sorted.length,
    iterationsPerSample
  }
}

/** Measures a synchronous operation after one untimed warmup. */
export const measureSync = (options: TimingOptions, fn: (iteration: number) => void): Timing => {
  const samples = sampleCount(options.samples)
  const warmup = options.warmupIterations ?? Math.min(options.iterationsPerSample, 2_000)
  for (let i = 0; i < warmup; i++) fn(-1 - i)

  let iteration = 0
  const values: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    for (let i = 0; i < options.iterationsPerSample; i++) fn(iteration++)
    values.push(((performance.now() - start) * 1e6) / options.iterationsPerSample)
  }
  return summarizeTimings(values, options.iterationsPerSample)
}

/** Measures an asynchronous operation after one untimed warmup. */
export const measureAsync = async (
  options: TimingOptions,
  fn: (iteration: number) => Promise<unknown>
): Promise<Timing> => {
  const samples = sampleCount(options.samples)
  const warmup = options.warmupIterations ?? Math.min(options.iterationsPerSample, 30)
  for (let i = 0; i < warmup; i++) await fn(-1 - i)

  let iteration = 0
  const values: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now()
    for (let i = 0; i < options.iterationsPerSample; i++) await fn(iteration++)
    values.push(((performance.now() - start) * 1e6) / options.iterationsPerSample)
  }
  return summarizeTimings(values, options.iterationsPerSample)
}

/** Formats a duration using the smallest unit that stays easy to scan. */
export const formatDuration = (ns: number): string => {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`
  if (ns < 1e6) return `${(ns / 1_000).toFixed(ns < 10_000 ? 2 : 1)} µs`
  if (ns < 1e9) return `${(ns / 1e6).toFixed(ns < 10e6 ? 2 : 1)} ms`
  return `${(ns / 1e9).toFixed(2)} s`
}

/** Formats equivalent single-thread throughput without implying production capacity. */
export const formatThroughput = (opsPerSec: number): string =>
  `${Math.round(opsPerSec).toLocaleString("en-US")} ops/s`

/** Returns the full fastest-to-slowest sample range. */
export const formatRange = (timing: Timing): string =>
  `${formatDuration(timing.fastestNsPerOp)}–${formatDuration(timing.slowestNsPerOp)}`

/** Relative width of the full sample range around the median. */
export const noisePercent = (timing: Timing): number =>
  ((timing.slowestNsPerOp - timing.fastestNsPerOp) / timing.nsPerOp) * 100

/** A short non-technical interpretation of timing variance. */
export const noiseLabel = (timing: Timing): string => {
  const noise = noisePercent(timing)
  if (noise <= 10) return "steady"
  if (noise <= 25) return "some noise"
  return "noisy"
}

/** Percentage of time removed when moving from a slower path to a faster one. */
export const percentFaster = (slowerNs: number, fasterNs: number): number =>
  (1 - fasterNs / slowerNs) * 100

/** Plain-language change in elapsed time, including regressions. */
export const formatTimeChange = (beforeNs: number, afterNs: number): string => {
  const change = percentFaster(beforeNs, afterNs)
  return change >= 0 ? `${change.toFixed(0)}% less` : `${Math.abs(change).toFixed(0)}% more`
}

/** Runtime name used in reports and machine-specific baseline filenames. */
export const runtimeName = (): "bun" | "node" =>
  typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"

/** One-line explanation printed above human-readable timing tables. */
export const timingLegend = (samples: number): string =>
  `Smaller is faster. Typical = median of ${samples} samples; range = fastest–slowest. 1 µs is one millionth of a second.`
