import { describe, expect, it } from "vitest"
import {
  assessBenchmarkTarget,
  BENCHMARK_REGRESSION_LIMIT,
  BENCHMARK_GATE_MIN_NS,
  benchmarkInvariantViolations,
  benchmarkRegressions,
  formatDuration,
  formatRange,
  formatTimeChange,
  noiseLabel,
  percentFaster,
  summarizeTimings,
  timingLegend,
  validateBenchmarkBaseline
} from "../scripts/bench-report.mts"

describe("benchmark reporting", () => {
  it("uses the median and preserves the visible sample range", () => {
    const timing = summarizeTimings([100, 50, 80, 60, 70], 1_000)

    expect(timing).toMatchObject({
      nsPerOp: 70,
      fastestNsPerOp: 50,
      slowestNsPerOp: 100,
      p95NsPerOp: 100,
      sampleCount: 5,
      iterationsPerSample: 1_000
    })
    expect(timing.opsPerSec).toBeCloseTo(1e9 / 70)
    expect(formatRange(timing)).toBe("50 ns–100 ns")
    expect(noiseLabel(timing)).toBe("noisy")
  })

  it("formats durations in units non-specialists can compare", () => {
    expect(formatDuration(420)).toBe("420 ns")
    expect(formatDuration(2_450)).toBe("2.45 µs")
    expect(formatDuration(2_450_000)).toBe("2.45 ms")
    expect(formatDuration(2_450_000_000)).toBe("2.45 s")
  })

  it("explains comparisons without relying on throughput ratios", () => {
    expect(percentFaster(10_000, 2_500)).toBe(75)
    expect(formatTimeChange(10_000, 2_500)).toBe("75% less")
    expect(formatTimeChange(10_000, 12_000)).toBe("20% more")
    expect(timingLegend(5)).toContain("median of 5 samples")
    expect(timingLegend(5)).toContain("one millionth of a second")
  })

  it("classifies inclusive hot-path targets with structured excess", () => {
    expect(assessBenchmarkTarget(2_000, 2_000)).toEqual({
      valueNs: 2_000,
      targetNs: 2_000,
      status: "met",
      ratio: 1,
      excessNs: 0
    })
    expect(assessBenchmarkTarget(3_200, 2_000)).toEqual({
      valueNs: 3_200,
      targetNs: 2_000,
      status: "over",
      ratio: 1.6,
      excessNs: 1_200
    })
    expect(() => assessBenchmarkTarget(Number.NaN, 2_000)).toThrow(/valueNs/)
    expect(() => assessBenchmarkTarget(1_000, 0)).toThrow(/targetNs/)
  })

  it("validates runtime baselines and regression threshold boundaries", () => {
    const baseline = validateBenchmarkBaseline({
      schemaVersion: 1,
      environment: { runtime: "node", version: "26.4.0", platform: "linux", architecture: "x64" },
      measurement: { statistic: "median", samples: 5 },
      metrics: { "point.cold": 10_000, "point.warm": 2_000 }
    }, { runtime: "node", platform: "linux", architecture: "x64" }, ["point.cold", "point.warm"])

    expect(benchmarkRegressions({ "point.warm": 2_000 * BENCHMARK_REGRESSION_LIMIT }, baseline)).toEqual([])
    expect(benchmarkRegressions({ "point.warm": 2_000 * BENCHMARK_REGRESSION_LIMIT + 1 }, baseline)).toEqual([
      expect.objectContaining({ metric: "point.warm" })
    ])
    expect(() => validateBenchmarkBaseline({ ...baseline, metrics: { "point.cold": -1 } }, { runtime: "node", platform: "linux", architecture: "x64" }, ["point.cold"])).toThrow(/metric/)
    expect(() => validateBenchmarkBaseline(baseline, { runtime: "bun", platform: "linux", architecture: "x64" }, ["point.cold"])).toThrow(/environment/)
    expect(benchmarkRegressions({ floor: 10_000 }, { ...baseline, metrics: { floor: BENCHMARK_GATE_MIN_NS - 1 } })).toEqual([])
  })

  it("enforces the cold-to-warm cache relationship", () => {
    expect(benchmarkInvariantViolations({ "point.cold": 10_000, "point.warm": 4_000 })).toEqual([])
    expect(benchmarkInvariantViolations({ "point.cold": 10_000, "point.warm": 5_000 })).toEqual([
      "point.warm must remain at least 2x faster than point.cold"
    ])
  })
})
