import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

// The auth tests sign in with the seed accounts and restore them through the
// service role (e2e/support/demo.ts), so they need .env.local like the app.
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI provides the variables directly.
}

/**
 * Default (`npm run test:e2e`): a production build (next build + next start) on its
 * own port, so a busy dev server never causes timeouts. `npm run test:e2e:dev`
 * (playwright.dev.config.ts) runs against `next dev` on 3000 instead.
 * PLAYWRIGHT_BASE_URL tests an app that is already running.
 */
export function e2eConfig(dev: boolean): PlaywrightTestConfig {
  const port = Number(process.env.PORT ?? (dev ? 3000 : 3100));
  // The app under test never sends real email: the fake transport records it (decision 73).
  const env = { ...(process.env as Record<string, string>), EMAIL_TRANSPORT: "fake", EMAIL_DEV_REDIRECT: "e2e-inbox@rentdesk.invalid" };
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

  // Key flows are tested on a mobile viewport first (CLAUDE.md: mobile-first, 360 px).
  return defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    // Three workers: with six, the free-tier Supabase project queued requests for 6-30 s
    // (even the one-row session check on every page) and owner actions timed out at random.
    // Three run as fast with far fewer stalls (task 7).
    workers: 3,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? "github" : "list",
    // The dev server compiles each route on first visit. The free-tier Supabase project
    // sometimes stalls every request for up to ~45 s (measured in task 7: even the
    // one-row session check; the Next server itself was idle), so steps may wait that long.
    timeout: dev ? 150_000 : 120_000,
    expect: { timeout: 45_000 },
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
      : dev
        ? {
            command: `npm run dev -- --port ${port}`,
            url: baseURL,
            env,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          }
        : {
            // Always a fresh build: reusing a running server could test stale code.
            command: `npm run build && npm run start -- --port ${port}`,
            url: baseURL,
            env,
            reuseExistingServer: false,
            timeout: 600_000,
          },
  });
}

export default e2eConfig(false);
