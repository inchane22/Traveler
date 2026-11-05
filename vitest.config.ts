import { defineConfig } from "vitest/config";

// prd-F19: run west of UTC, like the pilot users in Lima. In a UTC runner a regression to
// local-time date formatting would still print the right day, so the PRD case could not fail.
// Set before the workers start, so every test process inherits it.
process.env.TZ = "America/Lima";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { TZ: "America/Lima" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/lib/**/*.ts"],
      // src/h.ts is DOM-only; the e2e suite covers it.
      exclude: ["src/render/**", "src/app.ts", "src/main.ts", "src/sw-register.ts", "src/h.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
