import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { DEMO } from "./support/demo";

/**
 * Task 11 measurement (not part of the normal run): Supabase requests and their time
 * per page, on the production build. Run with
 *   QUERY_STATS=1 MEASURE=1 npx playwright test e2e/measure.spec.ts --workers=1
 * The server appends one line per Supabase request to query-stats.log
 * (src/lib/supabase/query-stats.ts); pages are opened one at a time, so every line
 * between a page's start and its network going idle belongs to it (the proxy's
 * session check included). Results: test-results/query-stats.json.
 */
test.skip(process.env.MEASURE !== "1", "measurement only (MEASURE=1 with QUERY_STATS=1)");

const LOG = path.join(process.cwd(), process.env.QUERY_STATS_FILE ?? "query-stats.log");

interface Line {
  at: number;
  ms: number;
  client: string;
  method: string;
  path: string;
}

const results: { page: string; requests: number; dbMs: number; slowestMs: number; pageMs: number; calls: string[] }[] = [];

async function measure(page: Page, url: string, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const started = Date.now();
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const loaded = Date.now();
    await page.waitForTimeout(300);
    const lines = (existsSync(LOG) ? readFileSync(LOG, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line)
      .filter((l) => l.at >= started && l.at <= loaded + 300);
    // The first round warms the server (fonts, route code); keep the later ones.
    if (i === 0) continue;
    results.push({
      page: url,
      requests: lines.length,
      dbMs: lines.reduce((t, l) => t + l.ms, 0),
      slowestMs: Math.max(0, ...lines.map((l) => l.ms)),
      pageMs: loaded - started,
      calls: lines.map((l) => `${l.client} ${l.method} ${l.path.replace(/^\/rest\/v1\//, "")} ${l.ms}ms`),
    });
  }
}

test.beforeAll(() => {
  rmSync(LOG, { force: true });
});

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(path.join("test-results", "query-stats.json"), JSON.stringify(results, null, 2));
  console.table(results.map((r) => ({ page: r.page, requests: r.requests, dbMs: r.dbMs, slowestMs: r.slowestMs, pageMs: r.pageMs })));
});

test("query count and time per page", async ({ page }) => {
  test.setTimeout(600_000);
  await signInCached(page, DEMO.ownerLanka, "/owner");
  for (const url of [
    "/owner",
    "/owner/reports/income?range=last_12_months",
    "/owner/reports/machines?range=last_3_months",
    "/owner/reports/customers?range=last_3_months",
    "/owner/reports/ageing",
    "/owner/reports/service?range=last_3_months",
    "/owner/reports/usage?range=last_12_months",
    "/owner/reports/rental",
    "/owner/reports/cycles?range=last_3_months",
  ]) {
    await measure(page, url);
  }
  await signInCached(page, DEMO.custPerera, "/customer");
  await measure(page, "/customer");
  await signInCached(page, DEMO.admin, "/admin");
  for (const url of ["/admin", "/admin/reports?range=last_12_months", "/admin/audit"]) await measure(page, url);
});
