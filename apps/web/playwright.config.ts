import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke against a real Kritvia API and `next start`.
 *
 *   KRITVIA_API_URL=http://localhost:8000 pnpm build && pnpm e2e
 *
 * The API must already be running (see README). Playwright starts `next start`
 * unless something is already listening on E2E_BASE_URL.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm start",
        url: `${baseURL}/login`,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
