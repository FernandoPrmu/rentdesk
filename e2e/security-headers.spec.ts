import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { DEMO } from "./support/demo";

// Security headers on every kind of response (decision 87), and no Content Security
// Policy violation on the main pages of each portal (Supabase REST, Storage images,
// the Realtime websocket of the bell, fonts, the service worker).

const SUPABASE = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://invalid.supabase.co").origin;

function expectSecurityHeaders(headers: Record<string, string>, label: string) {
  const csp = headers["content-security-policy"] ?? "";
  expect(csp, label).toContain("default-src 'self'");
  expect(csp, label).toContain("frame-ancestors 'none'");
  expect(csp, label).toContain(`connect-src 'self' ${SUPABASE} wss://${new URL(SUPABASE).host}`);
  expect(csp, label).toContain("object-src");
  expect(csp, label).not.toContain("'unsafe-eval'");
  expect(headers["strict-transport-security"], label).toBe("max-age=63072000; includeSubDomains");
  expect(headers["x-content-type-options"], label).toBe("nosniff");
  expect(headers["referrer-policy"], label).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"], label).toBe("DENY");
  expect(headers["permissions-policy"], label).toContain("camera=(self)");
  expect(headers["permissions-policy"], label).toContain("microphone=()");
  expect(headers["permissions-policy"], label).toContain("geolocation=()");
  expect(headers["x-powered-by"], label).toBeUndefined();
}

test("pages, redirects, API answers and static files carry the security headers", async ({ request }) => {
  for (const path of ["/", "/login", "/offline", "/api/version", "/manifest.webmanifest", "/icons/icon-192.png", "/sw.js"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBeLessThan(400);
    expectSecurityHeaders(res.headers(), path);
  }
  const redirect = await request.get("/customer", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expectSecurityHeaders(redirect.headers(), "/customer redirect");
  // Signed-out page requests all redirect to /login; an unknown API path answers 404 itself.
  const missing = await request.get("/api/no-such-route");
  expect(missing.status()).toBe(404);
  expectSecurityHeaders(missing.headers(), "404");
  expect((await request.get("/sw.js")).headers()["cache-control"]).toContain("no-store");
});

/** Records CSP violations and console errors that mention the policy. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const consoleHits: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) consoleHits.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => [...consoleHits, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []))];
}

async function visit(page: Page, path: string, violations: () => Promise<string[]>) {
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  expect(await violations(), path).toEqual([]);
}

test("the owner portal runs without a CSP violation", async ({ page }) => {
  const violations = await watchCsp(page);
  await signInCached(page, DEMO.ownerLanka, "/owner");
  for (const path of ["/owner", "/owner/tickets", "/owner/invoices", "/owner/payments", "/owner/customers", "/owner/settings/company", "/owner/settings/invoice-template", "/owner/reports/income"]) {
    await visit(page, path, violations);
  }
});

test("the customer and admin portals run without a CSP violation", async ({ page }) => {
  const violations = await watchCsp(page);
  await signInCached(page, DEMO.custPerera, "/customer");
  for (const path of ["/customer", "/customer/bills", "/customer/payments", "/customer/machines", "/customer/service/new", "/customer/help"]) {
    await visit(page, path, violations);
  }
  await signInCached(page, DEMO.admin, "/admin");
  for (const path of ["/admin", "/admin/owners", "/admin/audit", "/admin/settings"]) {
    await visit(page, path, violations);
  }
});
