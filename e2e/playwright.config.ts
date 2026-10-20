import { defineConfig, devices } from "@playwright/test";

/**
 * Run through `pnpm e2e` (e2e/run.mjs), which builds the app, starts it with fake providers on a free port
 * and passes the URLs in E2E_BASE_URL and E2E_PROD_URL. The scenarios share one instance and one database,
 * so they run in file order on one worker: 01 performs the first-run setup that the others sign in to.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /\d{2}-.*\.spec\.ts$/,
  outputDir: process.env.E2E_OUTPUT_DIR ?? "../test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
});
