import { createClient } from "@supabase/supabase-js";
import { expect, type Page, test } from "@playwright/test";

import { formatRupees } from "../src/lib/money.ts";
import { signInCached } from "./support/auth";
import { assignMachine, createMachine, submitFirstReading } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Notifications at 360 px (NOT-01..05; decisions 65-74). The app under test uses the fake
// email transport (playwright.config.ts), so nothing is really sent. Each test makes its
// own data and puts back what it changed.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serial = `${E2E_SERIAL_PREFIX}NOT-${run}`;

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

test.afterAll(async () => {
  await deleteE2eMachines(serial);
  const db = service();
  const owner = await profileId(DEMO.ownerLanka.username);
  await db.from("notification_templates").delete().eq("owner_id", owner).eq("event", "invoice.issued");
  await resetSilvaPreferences();
});

/** Back to the defaults (both on), through the same function the app uses. */
async function resetSilvaPreferences() {
  const { error } = await service().rpc("rpc_save_notification_preferences", { p_user_id: await profileId(DEMO.custSilva.username), p_reminders: true, p_updates: true });
  if (error) throw new Error(`e2e: reset preferences: ${error.message}`);
}

const unread = (page: Page) => page.getByTestId("notification-bell").first();
const unreadNumber = async (page: Page) => Number(await unread(page).getAttribute("data-unread"));

test("the customer's bell updates live when the owner confirms a reading; open one, then mark all as read", async ({ page, browser }) => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, serial, "MP 2701"), customer, today);
  const { ticketId, totalCents } = await submitFirstReading(agreementId, 2600);
  const billTitle = `New bill: ${formatRupees(totalCents)}`;

  // The customer is on Home; the bell has today's count.
  await signInCached(page, DEMO.custPerera, "/customer");
  await expect(unread(page)).toBeVisible();
  const before = await unreadNumber(page);

  // Meanwhile the owner confirms the reading on another phone.
  const ownerContext = await browser.newContext(test.info().project.use);
  const ownerPage = await ownerContext.newPage();
  try {
    await signInCached(ownerPage, DEMO.ownerLanka, "/owner");
    await ownerPage.goto(`/owner/tickets/${ticketId}/review`);
    await ownerPage.getByRole("button", { name: "Confirm invoice" }).click();
    await expect(ownerPage.getByText(/^Invoice INV-\d+ sent to the customer$/)).toBeVisible();
  } finally {
    await ownerContext.close();
  }

  // Live (Supabase Realtime), without reloading the customer's page.
  await expect.poll(() => unreadNumber(page), { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId("notification-badge")).toBeVisible();

  await unread(page).click();
  await expect(page).toHaveURL(/\/customer\/notifications$/);
  const item = page.getByRole("list", { name: "Notifications" }).getByRole("button", { name: billTitle }).first();
  await expect(item).toHaveAttribute("data-unread", "true");
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/customer/tickets/${ticketId}$`));

  await page.goto("/customer/notifications");
  await expect(page.getByRole("list", { name: "Notifications" }).getByRole("button", { name: billTitle }).first()).toHaveAttribute("data-unread", "false");
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByTestId("unread-count")).toHaveText("All read");
  await expect.poll(() => unreadNumber(page), { timeout: 15_000 }).toBe(0);
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
});

test("the owner changes an email template with a live preview; unknown variables are refused; reset to default", async ({ page }) => {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  await page.goto("/owner/settings");
  await page.getByRole("link", { name: /Emails: settings, templates, delivery log/ }).click();
  await page.getByRole("link", { name: /Email templates/ }).click();
  await page.getByRole("link", { name: /New bill \(PDF attached\)/ }).click();
  await expect(page.getByRole("heading", { name: "New bill (PDF attached)" })).toBeVisible();

  // The built-in text, previewed with sample details and the company name.
  await expect(page.getByTestId("preview-subject")).toHaveText("Subject: Your bill INV-000123: Rs. 12,800");

  const subject = page.getByLabel("Subject");
  await subject.fill("Bill {invoice_no} for {period}");
  await expect(page.getByText("Unknown variable: {period}.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save template" })).toBeDisabled();

  await subject.fill("Bill ");
  await subject.press("End");
  await page.getByRole("button", { name: "{invoice_no}" }).click();
  await subject.press("End");
  await subject.pressSequentially(" from ");
  await page.getByRole("button", { name: "{company_name}" }).click();
  await expect(subject).toHaveValue("Bill {invoice_no} from {company_name}");
  await expect(page.getByTestId("preview-subject")).toHaveText("Subject: Bill INV-000123 from Lanka Copy Solutions");
  await expect(page.frameLocator('[data-testid="email-preview"]').getByText("Lanka Copy Solutions").first()).toBeVisible();

  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Template saved")).toBeVisible();
  await page.goto("/owner/settings/notifications/templates");
  await expect(page.getByRole("link", { name: /New bill \(PDF attached\)/ })).toContainText("Your text");

  await page.getByRole("link", { name: /New bill \(PDF attached\)/ }).click();
  await expect(page.getByLabel("Subject")).toHaveValue("Bill {invoice_no} from {company_name}");
  await page.getByRole("button", { name: "Reset to default" }).click();
  await expect(page.getByText("Back to the default text")).toBeVisible();
  await expect(page.getByLabel("Subject")).toHaveValue("Your bill {invoice_no}: {amount}");
});

test("the customer turns off reminder emails; essential emails stay on", async ({ page }) => {
  await resetSilvaPreferences();
  await signInCached(page, DEMO.custSilva, "/customer");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Help" }).last().click();
  await page.getByRole("link", { name: "Email settings" }).click();
  await expect(page.getByRole("heading", { name: "Email settings" })).toBeVisible();
  await expect(page.getByText("Bills, receipts, login details and changes to your account are always emailed.")).toBeVisible();

  const reminders = page.getByRole("checkbox", { name: /Reminder emails/ });
  await expect(reminders).toBeChecked();
  await reminders.uncheck();
  await page.getByRole("button", { name: "Save email settings" }).click();
  await expect(page.getByText("Email settings saved")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Reminder emails/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Update emails/ })).toBeChecked();
  const { data } = await service()
    .from("notification_preferences")
    .select("email_reminders, email_updates")
    .eq("user_id", await profileId(DEMO.custSilva.username))
    .single();
  expect(data).toEqual({ email_reminders: false, email_updates: true });
});

test("a new customer's login details are also emailed; the owner sees it in the delivery log", async ({ page }) => {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  await page.goto("/owner/customers/new");
  const name = `E2E Mail ${run}`;
  await page.getByLabel("Customer name").fill(name);
  await page.getByLabel("Phone").fill("077 111 2233");
  const sendByEmail = page.getByRole("checkbox", { name: /Also send the login details by email/ });
  await expect(sendByEmail).toBeDisabled();
  await page.getByRole("textbox", { name: /^Email/ }).fill(`e2e-mail-${run.toLowerCase()}@example.com`);
  await expect(sendByEmail).toBeChecked();
  await page.getByRole("button", { name: "Create customer account" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("credential-email")).toHaveText(`Also emailed to e2e-mail-${run.toLowerCase()}@example.com.`);
  await expect(dialog.getByTestId("credential-password")).not.toBeEmpty();
  await dialog.getByLabel("I have saved these details").check();
  await dialog.getByRole("button", { name: "Done" }).click();

  // The delivery log shows the email (never the password).
  await page.goto("/owner/settings/notifications/log?channel=EMAIL");
  const row = page.getByTestId("log-row").filter({ hasText: name }).first();
  await expect(row).toContainText("Sent");
  await expect(row).toContainText("Login details (new account or password reset)");
});
