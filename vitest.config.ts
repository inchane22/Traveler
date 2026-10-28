import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/lib/**/*.ts"],
      // src/h.ts is DOM-only; the e2e suite covers it.
      exclude: ["src/render/**", "src/app.ts", "src/main.ts", "src/sw-register.ts", "src/h.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
