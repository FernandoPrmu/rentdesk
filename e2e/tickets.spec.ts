import { expect, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, ticketIds } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Billing cycle tickets at 360 px (TKT-01, TKT-06, CP-02): a machine assigned with its
// first billing date today; the daily job (called like Vercel Cron) opens the ticket;
// the owner sees it in the ticket list with its history, and the customer's Home asks
// for the meter reading with the deadline. The machine and its ticket are deleted
// afterwards.
test.describe.configure({ mode: "serial" });

const serial = `${E2E_SERIAL_PREFIX}TKT-${Date.now().toString(36).toUpperCase()}`;
const colombo = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(d);
const today = colombo(new Date());
// Meter deadline: 00:00 on day 5, so the last day to send it is day 4 (spec 5.4).
const lastDay = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(
  new Date(Date.parse(`${today}T00:00:00Z`) + 4 * 86_400_000),
);
let ticketId = "";

test.afterAll(async () => {
  await deleteE2eMachines(serial);
});

test.describe("billing cycle tickets and the daily job", () => {
  test("the daily job opens the ticket on the first billing date", async ({ request }) => {
    const owner = await profileId(DEMO.ownerLanka.username);
    const customer = await profileId(DEMO.custPerera.username);
    const agreementId = await assignMachine(owner, await createMachine(owner, serial), customer, today);
    expect(await ticketIds(agreementId)).toEqual([]);

    const unauthorised = await request.get("/api/cron/daily");
    expect(unauthorised.status()).toBe(401);

    const run = await request.get("/api/cron/daily", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, timeout: 90_000 });
    expect(run.ok(), await run.text()).toBe(true);
    const body = await run.json();
    expect(body.status).toMatch(/SUCCESS|PARTIAL/);
    [ticketId] = await ticketIds(agreementId);
    expect(ticketId).toBeTruthy();
  });

  test("the owner sees the new ticket in the list and its history", async ({ page }) => {
    await signInCached(page, DEMO.ownerLanka, "/owner");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tickets" }).click();
    await expect(page).toHaveURL(/\/owner\/tickets$/);

    const card = page.getByTestId("ticket-card").filter({ has: page.locator(`a[href="/owner/tickets/${ticketId}"]`) });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Perera Printers");
    await expect(card).toContainText("Meter requested");
    await expect(card).toContainText(`Customer: Send the meter reading and photo by ${lastDay}`);

    await card.getByRole("link").click();
    await expect(page.getByRole("heading", { name: /^Cycle 1 · / })).toBeVisible();
    await expect(page.getByTestId("ticket-who")).toHaveText("Perera Printers");
    await expect(page.getByTestId("ticket-timeline")).toContainText("Ticket opened: cycle 1");
    await expect(page.getByTestId("ticket-timeline")).toContainText("System");
  });

  test("the customer's Home asks for the meter reading with its deadline", async ({ page }) => {
    await signInCached(page, DEMO.custPerera, "/customer");
    await expect(page.getByRole("heading", { name: "What you need to do now" })).toBeVisible();
    const task = page.getByTestId("task-meter").filter({ hasText: "Ricoh MP 2501" });
    await expect(task).toHaveCount(1);
    await expect(task).toContainText("Enter meter reading");
    await expect(task.getByTestId("task-deadline")).toHaveText(`Send by ${lastDay}`);
    await expect(task.getByRole("alert")).toHaveCount(0);

    await task.getByRole("link", { name: "Enter meter reading" }).click();
    await expect(page).toHaveURL(new RegExp(`/customer/tickets/${ticketId}/meter$`));
    await expect(page.getByRole("heading", { name: "Enter meter reading" })).toBeVisible();
  });

  test("the admin sees the daily job's log, runs it now, and the escalations list", async ({ page }) => {
    await signInCached(page, DEMO.admin, "/admin");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Daily job" }).click();
    await expect(page.getByRole("heading", { name: "Daily job" })).toBeVisible();
    const before = await page.getByTestId("cron-run").count();
    expect(before).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Run daily job now" }).click();
    await expect(page.getByText(/^Daily job (done|finished with problems)/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("cron-run").first()).toContainText("Admin");

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Escalations" }).click();
    await expect(page.getByRole("heading", { name: "Escalations" })).toBeVisible();
  });
});
