import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/lib/**/*.ts"],
      exclude: ["src/render/**", "src/app.ts", "src/main.ts", "src/sw-register.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
