import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: "retain-on-failure",
    timezoneId: "America/Lima",
    locale: "es-PE",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  // The site under test is built from the frozen data in tests/fixtures/site, not data/: the
  // pipeline commits data every day, and a test pinned to a date or a status must not break on it.
  webServer: {
    command: `DATA_DIR=tests/fixtures/site pnpm build && pnpm preview`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
