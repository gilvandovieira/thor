import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Global floors sit just under the current measurement so a real
      // regression trips the gate while ordinary noise does not. Critical
      // failure-path modules carry stricter, module-specific floors below.
      thresholds: {
        statements: 87,
        branches: 78,
        functions: 86,
        lines: 89,
        // Correctness- and data-integrity-critical modules: binding, guards,
        // transactions, migration execution.
        "**/execution/transaction.ts": {
          statements: 90,
          branches: 80,
          functions: 90,
          lines: 90
        },
        "**/execution/run-pipeline.ts": {
          statements: 88,
          branches: 76,
          functions: 92,
          lines: 90
        },
        "**/migrate/migrator.ts": {
          statements: 90,
          branches: 72,
          functions: 92,
          lines: 90
        },
        "**/guards/query-guards.ts": {
          statements: 78,
          branches: 76,
          functions: 85,
          lines: 78
        }
      }
    }
  }
})
