import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/thor/test-stress/**/*.test.ts"],
    globals: false,
    fileParallelism: false
  }
})
