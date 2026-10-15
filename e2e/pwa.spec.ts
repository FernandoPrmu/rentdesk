import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { signInAndWait, signInCached } from "./support/auth";
import { DEMO } from "./support/demo";

// PWA at 360 px (CP-09; decisions 88-90): manifest and icons, install prompt (Android
// event and iOS steps, never on /login, once), offline page, static-only caching,
// "New version available" and the sign-out clean-up. Runs on the production build,
// where the service worker is registered.

test.use({ storageState: { cookies: [], origins: [] } });

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** The card waits for the user's first tap or key press (decision 90). */
const interact = (page: Page) => page.keyboard.press("Shift");

/** Fires a fake `beforeinstallprompt` whose prompt() records that it was called. */
async function fireInstallEvent(page: Page, outcome: "accepted" | "dismissed" = "accepted") {
  await page.evaluate((choice) => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & Record<string, unknown>;
    e.prompt = async () => {
      (window as unknown as Record<string, unknown>).__installPrompted = true;
    };
    e.userChoice = Promise.resolve({ outcome: choice });
    window.dispatchEvent(e);
  }, outcome);
}

async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
}

/** Every URL the service worker keeps, in any cache. */
async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(`${name} ${req.url}`);
    }
    return urls;
  });
}

test("the manifest is complete and every icon loads", async ({ request, page }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ name: "RentDesk", short_name: "RentDesk", start_url: "/?source=pwa", scope: "/", display: "standalone", theme_color: "#1e40af" });
  expect(m.icons.map((i: { purpose: string }) => i.purpose)).toEqual(expect.arrayContaining(["any", "maskable", "monochrome"]));
  expect(m.shortcuts.map((s: { url: string }) => s.url)).toEqual(["/customer/bills", "/customer/pay", "/customer/service/new", "/owner/approvals"]);
  const icons = [...m.icons, ...m.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)] as { src: string }[];
  for (const icon of icons) {
    const r = await request.get(icon.src);
    expect(r.ok(), icon.src).toBe(true);
    expect(r.headers()["content-type"]).toContain("image/png");
  }

  await page.goto("/login");
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(apple).toBeTruthy();
  expect((await request.get(apple!)).ok()).toBe(true);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
});

test.describe("install prompt (decision 90)", () => {
  test("never on the sign-in page, then once after signing in; Not now is remembered", async ({ page }) => {
    await page.goto("/login");
    await fireInstallEvent(page);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);

    // Signing in from this same page is a client-side navigation: the event caught on
    // /login is offered now.
    await page.getByLabel("Username").fill(DEMO.custSilva.username);
    await page.getByLabel("Password", { exact: true }).fill(DEMO.custSilva.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/customer$/);
    const card = page.getByTestId("install-prompt");
    await page.waitForTimeout(1000);
    await expect(card).toHaveCount(0); // not before the user's first tap or key press
    await interact(page);
    await expect(card.getByRole("heading", { name: "Install RentDesk on this phone" })).toBeVisible();
    await card.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await fireInstallEvent(page);
    await interact(page);
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);
  });

  test("Install opens the browser's dialog and the card goes away", async ({ page }) => {
    await signInCached(page, DEMO.ownerLanka, "/owner");
    await fireInstallEvent(page, "accepted");
    await interact(page);
    const card = page.getByTestId("install-prompt");
    await card.getByRole("button", { name: "Install" }).click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__installPrompted)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("rentdesk:install-prompt"))).toBe("installed");
  });

  test("iPhone: Add to Home Screen steps, shown until Got it", async ({ browser }) => {
    const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await signInCached(page, DEMO.custPerera, "/customer");
    await interact(page);
    const card = page.getByTestId("install-prompt");
    await expect(card.getByText("Add to Home Screen")).toBeVisible();
    await expect(card.getByText(/tap the Share button/)).toBeVisible();
    await card.getByRole("button", { name: "Got it" }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await interact(page);
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("install-prompt")).toHaveCount(0);
    await context.close();
  });
});

test.describe("service worker (decision 88)", () => {
  test("pages that cannot load show the offline page, which returns by itself", async ({ page, context }) => {
    await signInCached(page, DEMO.custPerera, "/customer");
    await waitForServiceWorker(page);

    await context.setOffline(true);
    await page.goto("/customer/bills").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "No internet connection" })).toBeVisible();
    // The address stays the one the user wanted.
    expect(new URL(page.url()).pathname).toBe("/customer/bills");

    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "No internet connection" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /bills/i }).first()).toBeVisible();
  });

  test("only static files are ever cached, never a page, API answer, PDF or signed URL", async ({ page }) => {
    await signInCached(page, DEMO.ownerLanka, "/owner");
    await waitForServiceWorker(page);
    for (const path of ["/owner/tickets", "/owner/invoices", "/owner/customers", "/owner"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }
    await page.evaluate(() => fetch("/api/version").then((r) => r.text()));

    const urls = await cachedUrls(page);
    expect(urls.length).toBeGreaterThan(0);
    for (const entry of urls) {
      const url = new URL(entry.split(" ")[1]);
      expect(url.origin, entry).toBe(new URL(page.url()).origin);
      expect(url.pathname, entry).toMatch(/^\/(_next\/static\/|icons\/|offline$|manifest\.webmanifest$|icon\.svg$|apple-icon\.png$)/);
    }
  });
});

test.describe("new version banner (decision 89)", () => {
  // Without the worker, so the mocked /api/version answer is the one the page sees.
  test.use({ serviceWorkers: "block" });

  test("tap to refresh reloads the same page", async ({ page }) => {
    await signInCached(page, DEMO.custPerera, "/customer");
    await page.goto("/customer/bills");
    await expect(page.getByText("New version available — tap to refresh")).toHaveCount(0);

    await page.route("**/api/version", (route) => route.fulfill({ json: { buildId: "a-newer-build" } }));
    await page.evaluate(() => window.dispatchEvent(new Event("rentdesk:check-version")));
    const banner = page.getByRole("button", { name: "New version available — tap to refresh" });
    await expect(banner).toBeVisible();

    await page.unroute("**/api/version");
    const reloaded = page.waitForEvent("load");
    await banner.click();
    await reloaded;
    expect(new URL(page.url()).pathname).toBe("/customer/bills");
    await expect(banner).toHaveCount(0);
  });

  test("the version answer is never cached and holds no user data", async ({ request }) => {
    const res = await request.get("/api/version");
    expect(res.ok()).toBe(true);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(Object.keys(await res.json())).toEqual(["buildId"]);
  });
});

test("signing out clears drafts, session data and every non-static cache", async ({ page }) => {
  await signInAndWait(page, DEMO.custPerera.username, DEMO.custPerera.password, /\/customer$/);
  await seedUserData(page.context(), page);

  await page.goto("/customer/help");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login$/);

  await expect
    .poll(async () => page.evaluate(async () => ({ keys: Object.keys(localStorage).sort(), session: sessionStorage.length, caches: (await caches.keys()).sort() })))
    .toEqual({ keys: ["rentdesk:install-prompt"], session: 0, caches: expect.not.arrayContaining(["pages", "apis"]) });
});

async function seedUserData(_context: BrowserContext, page: Page) {
  await page.evaluate(async () => {
    localStorage.setItem("rentdesk:meter-draft:test", JSON.stringify({ b: "1234" }));
    localStorage.setItem("rentdesk:pay-draft", JSON.stringify({ amount: "100" }));
    localStorage.setItem("rentdesk:install-prompt", "dismissed");
    sessionStorage.setItem("x", "y");
    // What an earlier version of the worker (Serwist's defaultCache) left behind.
    await (await caches.open("pages")).put("/customer", new Response("<html>old page</html>"));
    await (await caches.open("apis")).put("/api/anything", new Response("{}"));
  });
}
