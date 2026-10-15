import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, openFirstCycle } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Accessibility at 360 px (spec 13 usability; task 12): axe-core on the main pages of
// each portal, WCAG 2.1 A and AA rules. Serious and critical findings fail the test;
// moderate and minor ones are printed for the record.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function audit(page: Page, label: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Streamed sections (dashboards) settle before the scan.
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 15_000 }).catch(() => undefined);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const minor = result.violations.filter((v) => !blocking.includes(v));
  if (minor.length) console.info(`[a11y] ${label}: ${minor.map((v) => `${v.id} (${v.impact}, ${v.nodes.length})`).join(", ")}`);
  const summary = blocking.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 5).map((n) => n.target.join(" ")).join("\n  ")}`);
  // Soft: one run reports every page's findings, the test still fails at the end.
  expect.soft(summary, `${label}: serious or critical accessibility issues`).toEqual([]);
}

async function check(page: Page, path: string) {
  await page.goto(path);
  await audit(page, path);
}

test("sign-in, landing and offline pages", async ({ page }) => {
  for (const path of ["/", "/login", "/offline"]) await check(page, path);
});

test("customer portal: Home, bills, a bill, pay, service, machines, help", async ({ page }) => {
  await signInCached(page, DEMO.custPerera, "/customer");
  await audit(page, "/customer");
  for (const path of ["/customer/bills", "/customer/pay", "/customer/payments", "/customer/service", "/customer/service/new", "/customer/machines", "/customer/help", "/customer/notifications"]) {
    await check(page, path);
  }
  await page.goto("/customer/bills");
  const bill = page.locator('a[href^="/customer/bills/"]').first();
  if (await bill.count()) {
    await bill.click();
    await expect(page).toHaveURL(/\/customer\/bills\/[0-9a-f-]+$/);
    await audit(page, "/customer/bills/[id]");
  }
});

test.describe("customer meter entry page", () => {
  const serial = `${E2E_SERIAL_PREFIX}A11Y-${Date.now().toString(36).toUpperCase()}`;
  let ticketId = "";

  test.beforeAll(async () => {
    const owner = await profileId(DEMO.ownerLanka.username);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
    const agreementId = await assignMachine(owner, await createMachine(owner, serial, "A11Y 100"), await profileId(DEMO.custSilva.username), today);
    ticketId = await openFirstCycle(agreementId);
  });

  test.afterAll(async () => {
    await deleteE2eMachines(serial);
  });

  test("its own machine's open cycle", async ({ page }) => {
    await signInCached(page, DEMO.custSilva, "/customer");
    await check(page, `/customer/tickets/${ticketId}/meter`);
  });
});

test("owner portal: Home, tickets, review, customers, machines, invoices, reports", async ({ page }) => {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  await audit(page, "/owner");
  for (const path of ["/owner/tickets", "/owner/approvals", "/owner/customers", "/owner/machines", "/owner/invoices", "/owner/payments", "/owner/outstanding", "/owner/service", "/owner/reports", "/owner/reports/income", "/owner/settings/company"]) {
    await check(page, path);
  }
  await page.goto("/owner/approvals");
  const review = page.locator('a[href$="/review"]').first();
  if (await review.count()) {
    await review.click();
    await expect(page).toHaveURL(/\/review$/);
    await audit(page, "/owner/tickets/[id]/review");
  }
});

test("admin portal: dashboard, owners, audit log, settings", async ({ page }) => {
  await signInCached(page, DEMO.admin, "/admin");
  await audit(page, "/admin");
  for (const path of ["/admin/owners", "/admin/escalations", "/admin/audit", "/admin/settings", "/admin/reports"]) await check(page, path);
});

test("keyboard only: skip to content, then sign in with Tab and Enter", async ({ page }) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();

  // Focus order follows the form: username, password, show password, sign in.
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Username")).toBeFocused();
  await page.keyboard.type(DEMO.custSilva.username);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type(DEMO.custSilva.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/customer$/);

  // In the portal (a fresh page load) the skip link comes first too, and the main navigation is reachable by name.
  await page.goto("/customer");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Bills" }).last()).toBeVisible();
});
