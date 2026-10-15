import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { DEMO } from "./support/demo";

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
  expect(summary, `${label}: serious or critical accessibility issues`).toEqual([]);
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

test("customer meter entry page", async ({ page }) => {
  await signInCached(page, DEMO.custSilva, "/customer");
  const meter = page.locator('a[href*="/meter"]').first();
  test.skip((await meter.count()) === 0, "no meter task open for this customer today");
  await meter.click();
  await expect(page).toHaveURL(/\/meter$/);
  await audit(page, "/customer/tickets/[id]/meter");
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
