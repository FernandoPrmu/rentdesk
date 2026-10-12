import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { type Download, expect, type Page, test } from "@playwright/test";
import readXlsxFile from "read-excel-file/node";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, issueFirstInvoice } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";
import { pdfText } from "./support/pdf";

// Task 11 at 360 px: owner dashboard and every report with PDF and Excel export, the
// customer dashboard, admin settings -> audit log, the read-only support view, the
// More menu and the owner's reminder settings. Each test builds its own data (an E2E
// machine with an issued bill) and puts back what it changed.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serial = `${E2E_SERIAL_PREFIX}RPT-${run}`;
const REPORTS = ["income", "machines", "customers", "ageing", "service", "usage", "rental", "cycles"] as const;

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

let ownerId: string;
let adminId: string;
let invoiceNo: string;
let noticeBefore: number;

test.beforeAll(async () => {
  ownerId = await profileId(DEMO.ownerLanka.username);
  adminId = await profileId(DEMO.admin.username);
  const customerId = await profileId(DEMO.custPerera.username);
  const machineId = await createMachine(ownerId, serial, "RPT 3000");
  const agreementId = await assignMachine(ownerId, machineId, customerId, today);
  ({ invoiceNo } = await issueFirstInvoice(agreementId, 2600));
  const { data } = await service().from("platform_settings").select("agreement_end_notice_days").single();
  noticeBefore = data!.agreement_end_notice_days;
});

test.afterAll(async () => {
  await deleteE2eMachines(serial);
  const db = service();
  await db.rpc("rpc_update_platform_settings", { p_actor_id: adminId, p_changes: { agreement_end_notice_days: noticeBefore } });
  await db.rpc("rpc_update_owner_settings", { p_actor_id: ownerId, p_changes: { agreement_end_notice_days: null } });
});

async function download(page: Page, name: "PDF" | "Excel"): Promise<{ file: Download; bytes: Buffer }> {
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-export").getByRole("link", { name }).click()]);
  return { file, bytes: readFileSync(await file.path()) };
}

test("the owner's dashboard taps through, and every report opens and exports PDF and Excel", async ({ page }) => {
  test.setTimeout(400_000);
  await signInCached(page, DEMO.ownerLanka, "/owner");
  const dash = page.getByTestId("owner-dashboard");
  await expect(dash.getByTestId("card-income")).toBeVisible();
  for (const id of ["card-outstanding", "card-review", "card-tickets", "home-service", "card-machines", "card-rating", "card-deposits", "card-ending", "card-top-machines", "card-recent-payments"]) {
    await expect(dash.getByTestId(id)).toBeVisible();
  }
  await dash.getByTestId("card-income").click();
  await expect(page).toHaveURL(/\/owner\/reports\/income\?range=this_month$/);
  await expect(page.getByRole("heading", { name: "Monthly income and sales" })).toBeVisible();

  await page.goto("/owner/reports");
  await expect(page.getByTestId("report-list").getByRole("link")).toHaveCount(REPORTS.length);

  for (const report of REPORTS) {
    await page.goto(`/owner/reports/${report}?range=this_month`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const pdf = await download(page, "PDF");
    expect(pdf.file.suggestedFilename()).toMatch(new RegExp(`^${report}-.*\\.pdf$`));
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const xlsx = await download(page, "Excel");
    expect(xlsx.file.suggestedFilename()).toMatch(new RegExp(`^${report}-.*\\.xlsx$`));
    const sheets = await readXlsxFile(xlsx.bytes);
    expect(sheets.length).toBeGreaterThan(0);
    if (report === "machines") {
      // This run's machine: revenue Rs. 6,500 and 2,600 copies, as numbers in the sheet.
      const row = sheets[0].data.find((r) => typeof r[0] === "string" && r[0].includes(serial));
      expect(row?.[2]).toBe(6500);
      expect(row?.[6]).toBe(2600);
      expect((await pdfText(pdf.bytes)).replace(/\s+/g, "")).toContain(serial);
    }
    if (report === "ageing") {
      const bills = sheets.find((s) => s.sheet === "Unpaid bills")!;
      const row = bills.data.find((r) => r[0] === invoiceNo);
      expect(row?.[2]).toBeInstanceOf(Date);
      expect(row?.[6]).toBe(6500);
    }
  }

  // A custom range is checked: start after end shows a message, not an error page.
  await page.goto("/owner/reports/income?range=custom&from=2026-05-01&to=2026-04-01");
  await expect(page.getByTestId("range-filter").getByRole("alert")).toHaveText("The start date must be before the end date.");
});

test("the customer's Home shows balance, machines, latest bill, payments and requests", async ({ page }) => {
  await signInCached(page, DEMO.custPerera, "/customer");
  await expect(page.getByRole("heading", { name: "What you need to do now" })).toBeVisible();
  await expect(page.getByTestId("customer-outstanding")).toContainText("Rs.");
  await expect(page.getByTestId("customer-machines")).toContainText(serial);
  await expect(page.getByTestId("customer-machines")).toContainText("Next meter reading");
  for (const id of ["customer-latest-bill", "customer-payments", "customer-requests"]) await expect(page.getByTestId(id)).toBeVisible();
  await page.getByTestId("customer-machines").getByRole("link", { name: /All/ }).click();
  await expect(page).toHaveURL(/\/customer\/machines$/);
});

test("the admin changes a setting (checked) and finds it in the audit log with old and new values", async ({ page }) => {
  await signInCached(page, DEMO.admin, "/admin");
  await expect(page.getByTestId("admin-dashboard")).toBeVisible();
  await expect(page.getByTestId("email-usage")).toBeVisible();
  await expect(page.getByTestId("job-health")).toBeVisible();

  await page.goto("/admin/settings");
  const form = page.getByTestId("platform-settings-form");
  // A reminder after the deadline is refused with the reason, nothing saved.
  const reminders = form.getByRole("textbox", { name: /^Remind the customer on day/ });
  const remindersBefore = await reminders.inputValue();
  await reminders.fill("2, 40");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(form.getByTestId("setting-meter_reminder_days")).toContainText("Each value must be between 1 and 27.");
  await reminders.fill(remindersBefore);

  const next = noticeBefore === 45 ? 46 : 45;
  await form.getByRole("textbox", { name: /^Remind the owner before an agreement ends/ }).fill(String(next));
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved (1 change)")).toBeVisible();

  await page.goto("/admin/settings");
  await page.getByRole("link", { name: "Change history" }).click();
  await expect(page).toHaveURL(/\/admin\/audit\?entity=platform_settings$/);
  await page.getByTestId("audit-row").first().click();
  const changes = page.getByTestId("audit-changes");
  await expect(changes).toContainText("agreement_end_notice_days");
  await expect(changes.getByRole("row", { name: /agreement_end_notice_days/ })).toContainText(`${noticeBefore}${next}`);
  await expect(page.getByTestId("audit-entry")).toContainText("admin");
});

test("the admin opens the read-only support view: banner, no forms, logged; owner pages stay closed", async ({ page }) => {
  await signInCached(page, DEMO.admin, "/admin");
  await page.goto(`/admin/owners/${ownerId}`);
  const reason = `E2E support ${run}`;
  await page.getByTestId("support-entry").getByRole("textbox", { name: /Reason/ }).fill(reason);
  await page.getByRole("button", { name: "Open support view" }).click();
  await expect(page.getByTestId("support-banner")).toHaveText(/Support view — read only/);
  await expect(page.getByTestId("owner-dashboard")).toBeVisible();
  await expect(page.locator("main form")).toHaveCount(0);

  await page.getByRole("navigation", { name: "Support sections" }).getByRole("link", { name: "Machines" }).click();
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
  await expect(page.locator("main").getByText(serial).first()).toBeVisible();
  await expect(page.locator("main form")).toHaveCount(0);
  await expect(page.locator("main").getByRole("button")).toHaveCount(0);

  await page.goto(`/admin/owners/${ownerId}/support/reports/machines?range=this_month`);
  await expect(page.getByTestId("support-banner")).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-export").getByRole("link", { name: "Excel" }).click()]);
  expect(file.suggestedFilename()).toMatch(/^machines-.*\.xlsx$/);

  // Every page was logged with the admin, the owner and the page; the first with the reason.
  const { data: logs } = await service()
    .from("audit_logs")
    .select("actor_id, owner_id, details")
    .eq("action", "SUPPORT_VIEW")
    .eq("actor_id", adminId)
    .eq("owner_id", ownerId)
    .order("id", { ascending: false })
    .limit(10);
  const paths = (logs ?? []).map((l) => (l.details as { path: string }).path);
  expect(paths).toContain(`/admin/owners/${ownerId}/support/machines`);
  expect(paths).toContain(`/admin/owners/${ownerId}/support/reports/machines?export=xlsx`);
  expect((logs ?? []).some((l) => (l.details as { reason?: string }).reason === reason)).toBe(true);

  // Owner screens (where every write lives) stay closed to the admin.
  await page.goto("/owner/machines/new");
  await expect(page).toHaveURL(/\/admin$/);
  // The owner's export cannot be asked for another tenant by an owner, nor without an owner by an admin.
  expect((await page.request.get("/api/reports/income?format=pdf")).status()).toBe(404);
});

test("the More menu reaches every section on a phone (owner and admin)", async ({ page }) => {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar.getByRole("link")).toHaveCount(4);
  await page.getByTestId("nav-more").click();
  const more = page.getByRole("navigation", { name: "More" });
  for (const name of ["Machines", "Invoices", "Payments", "Outstanding", "Approvals", "Reports", "Notifications", "Settings"]) {
    await expect(more.getByRole("link", { name })).toBeVisible();
  }
  await more.getByRole("link", { name: "Reports" }).click();
  await expect(page).toHaveURL(/\/owner\/reports$/);
  await expect(page.getByTestId("more-sheet")).toBeHidden();
  await expect(page.getByTestId("nav-more")).toHaveAttribute("aria-current", "page");

  await signInCached(page, DEMO.admin, "/admin");
  await page.getByTestId("nav-more").click();
  await page.getByRole("navigation", { name: "More" }).getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
});

test("the owner overrides the agreement reminder and goes back to the platform default", async ({ page }) => {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  await page.goto("/owner/settings/reminders");
  const field = page.getByTestId("setting-agreement_end_notice_days");
  const useDefault = field.getByRole("checkbox", { name: "Use the platform default" });
  await useDefault.uncheck();
  await field.getByRole("textbox").fill("60");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/^Saved \(1 change\)$/)).toBeVisible();
  const { data } = await service().from("owner_settings_effective").select("agreement_end_notice_days").eq("owner_id", ownerId).single();
  expect(data?.agreement_end_notice_days).toBe(60);

  await page.reload();
  await field.getByRole("checkbox", { name: "Use the platform default" }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/^Saved \(1 change\)$/)).toBeVisible();
  const { data: own } = await service().from("owner_settings").select("agreement_end_notice_days").eq("owner_id", ownerId).single();
  expect(own?.agreement_end_notice_days).toBeNull();
});
