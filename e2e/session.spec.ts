import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { signInAndWait } from "./support/auth";
import { DEMO, E2E_SERIAL_PREFIX } from "./support/demo";

// Server Actions after the session ends (AUTH-09): the proxy never answers an
// action with a redirect, so React never sees "An unexpected response was received
// from the server". Every case must land on /login without a console error.

const IDLE_MESSAGE = "You were signed out after a period of inactivity.";

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Pretend the last request was 31 minutes ago (the idle limit is 30). */
async function goIdle(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    { name: "rd_seen", value: String(Date.now() - 31 * 60_000), url: baseURL, httpOnly: true, sameSite: "Lax" },
  ]);
}

test.describe("signing out (AUTH-09)", () => {
  const portals = [
    { name: "owner", account: DEMO.ownerLanka, home: /\/owner$/, start: "/owner" },
    { name: "admin", account: DEMO.admin, home: /\/admin$/, start: "/admin" },
    // The customer portal has its sign-out button on the Help tab.
    { name: "customer", account: DEMO.custPerera, home: /\/customer$/, start: "/customer/help" },
  ];

  for (const portal of portals) {
    test(`from the ${portal.name} portal lands on /login`, async ({ page }) => {
      const errors = collectErrors(page);
      await signInAndWait(page, portal.account.username, portal.account.password, portal.home);
      await page.goto(portal.start);
      await page.getByRole("button", { name: "Sign out" }).first().click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      // Really signed out.
      await page.goto(portal.start);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("Server Actions after the idle timeout (AUTH-09)", () => {
  test("submitting a form goes to /login with the timeout message", async ({ page, context, baseURL }) => {
    const errors = collectErrors(page);
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto("/owner/machines/new");
    await page.getByLabel("Brand").fill("Ricoh");
    await page.getByLabel("Model").fill("MP 2555");
    await page.getByLabel("Serial number").fill(`${E2E_SERIAL_PREFIX}IDLE-${Date.now().toString(36)}`);

    await goIdle(context, baseURL!);
    await page.getByRole("button", { name: "Register machine" }).click();

    await expect(page).toHaveURL(/\/login\?reason=idle$/);
    await expect(page.getByText(IDLE_MESSAGE, { exact: false })).toBeVisible();
    await page.goto("/owner/machines");
    await expect(page).toHaveURL(/\/login\?next=/);
    expect(errors).toEqual([]);
  });

  test("signing out after the timeout also lands on /login with the message", async ({ page, context, baseURL }) => {
    const errors = collectErrors(page);
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await goIdle(context, baseURL!);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page).toHaveURL(/\/login\?reason=idle$/);
    await expect(page.getByText(IDLE_MESSAGE, { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
