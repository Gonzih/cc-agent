import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts"],
      all: true,
    },
  },
});
