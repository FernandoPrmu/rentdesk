import { defineConfig, devices } from "@playwright/test";

// The auth tests sign in with the seed accounts and restore them through the
// service role (e2e/support/demo.ts), so they need .env.local like the app.
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI provides the variables directly.
}

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

// Key flows are tested on a mobile viewport first (CLAUDE.md: mobile-first, 360 px).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // The dev server compiles each route on first visit.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  globalSetup: "./e2e/support/global-setup.ts",
  globalTeardown: "./e2e/support/global-teardown.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "mobile-chrome", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 740 } } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
