import { expect, type Page, test } from "@playwright/test";

import { signInAndWait } from "./support/auth";
import { createMachine, issueFirstInvoice } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Client decisions at 360 px: assign with a security deposit and an advance payment
// (DEP-01/02), the agreement shows the deposit held, the advance is taken off the
// first invoice (rule 13), the machine is returned while that invoice is unpaid
// and the deposit pays part of it (RET-01, DEP-03), and the customer still sees
// what is left to pay. The machine and everything it produced is deleted afterwards.
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await deleteE2eMachines(serial);
});

const serial = `${E2E_SERIAL_PREFIX}DEP-${Date.now().toString(36).toUpperCase()}`;
let machineId = "";
let agreementUrl = "";
let firstInvoice = { invoiceNo: "", totalCents: 0 };

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const tenDaysAgo = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date(Date.now() - 10 * 86_400_000));

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("combobox", { name: combobox, exact: true })).toContainText(option);
}

const signInOwner = (page: Page) => signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);

test.describe("deposits, advances and returning with a balance (DEP-01..04, RET-01)", () => {
  test.beforeAll(async () => {
    machineId = await createMachine(await profileId(DEMO.ownerLanka.username), serial);
  });

  test("owner assigns with a deposit and an advance; the agreement shows the deposit held", async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/owner/machines/${machineId}/assign`);

    await choose(page, "Customer", "Silva Stationers");
    await page.getByLabel("Installation location").fill("Counter");
    await page.getByLabel("Start date").fill(tenDaysAgo);
    // First billing today, so the first invoice can be issued in this test.
    await page.getByLabel("First billing date").fill(today);
    await expect(page.getByTestId("first-billing-preview")).toContainText("Monthly on the");
    await page.getByLabel("B&W counter", { exact: true }).fill("1000");
    await page.getByLabel("Monthly commitment").fill("5,000");
    await page.getByLabel("Included B&W copies").fill("2000");
    await page.getByLabel("B&W excess rate (per copy)").fill("2.50");
    await choose(page, "Late fee", "No late fee");

    await page.getByRole("button", { name: "Add money received" }).click();
    await page.getByLabel("Amount (payment 1)").fill("1,000");
    await choose(page, "Paid by (payment 1)", "Cash");
    await page.getByLabel("Reference (payment 1)").fill("RCPT-1");

    await page.getByRole("button", { name: "Add money received" }).click();
    await choose(page, "Type (payment 2)", "Advance payment");
    await page.getByLabel("Amount (payment 2)").fill("2,000");
    // Missing method: a clear error on that row.
    await page.getByRole("button", { name: "Assign machine" }).click();
    await expect(page.getByText("Choose how it was paid.")).toBeVisible();
    await choose(page, "Paid by (payment 2)", "Bank transfer");
    await page.getByRole("button", { name: "Assign machine" }).click();

    await expect(page).toHaveURL(/\/owner\/agreements\/[0-9a-f-]{36}\?assigned=1$/);
    agreementUrl = new URL(page.url()).pathname;
    await expect(page.getByTestId("agreement-deposit-held")).toHaveText("Rs. 1,000");
    await expect(page.getByRole("list", { name: "Advance payments" })).toContainText("Rs. 2,000");
    await expect(page.getByText("Late fee", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  });

  test("the advance is taken off the first invoice automatically", async () => {
    firstInvoice = await issueFirstInvoice(agreementUrl.split("/").pop()!, 100);
    expect(firstInvoice.totalCents).toBe(300_000); // Rs. 5,000 - Rs. 2,000 advance
  });

  test("the customer sees the deposit held on the Machines tab", async ({ page }) => {
    await signInAndWait(page, DEMO.custSilva.username, DEMO.custSilva.password, /\/customer$/);
    await page.getByRole("link", { name: "Machines" }).first().click();
    const card = page.getByTestId("agreement-card").filter({ hasText: serial });
    await expect(card).toContainText("Deposit held: Rs. 1,000");
    await expect(card).toContainText("Rs. 5,000 per month");
  });

  test("owner returns it with the invoice unpaid; the deposit pays part of the balance", async ({ page }) => {
    await signInOwner(page);
    await page.goto(`/owner/machines/${machineId}/return`);
    await expect(page.getByText("This machine cannot be returned yet")).toHaveCount(0);

    await expect(page.getByTestId("return-deposit-held")).toHaveText("Rs. 1,000");
    await page.getByLabel("Closing B&W reading").fill("1,150");
    // Live preview of the final invoice: the cycle in progress, prorated by its real days.
    await expect(page.getByTestId("final-invoice-total")).toBeVisible();
    await expect(page.getByTestId("final-invoice-preview")).toContainText("Commitment for 1 of");
    await page.getByLabel("Reason for the return").fill("Customer closed the counter");

    // Settle now: Rs. 1,000 pays the bills (oldest first), nothing refunded.
    await expect(page.getByLabel("Pay unpaid bills")).toHaveValue("1000");
    await expect(page.getByTestId("deposit-total")).toContainText("Adds up to the deposit held: Rs. 1,000");
    // A split that does not add up is refused before anything is saved.
    await page.getByLabel("Pay unpaid bills").fill("900");
    await expect(page.getByTestId("deposit-total")).toContainText("it must be Rs. 1,000");
    await page.getByRole("button", { name: "Return machine" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /must equal the deposit held/ })).toBeVisible();
    await page.getByLabel("Pay unpaid bills").fill("1,000");

    await page.getByRole("button", { name: "Return machine" }).click();
    await expect(page).toHaveURL(/\?returned=1$/);
    await expect(page.getByText("Available", { exact: true }).filter({ visible: true })).toBeVisible();

    await page.goto(agreementUrl);
    await expect(page.getByTestId("agreement-deposit-held")).toHaveText("Rs. 0");
    await expect(page.getByRole("list", { name: "Deposit history" })).toContainText("Paid an invoice");
  });

  test("the customer still sees the balance and the unpaid invoices", async ({ page }) => {
    await signInAndWait(page, DEMO.custSilva.username, DEMO.custSilva.password, /\/customer$/);
    await page.getByRole("link", { name: "Bills" }).first().click();
    await expect(page.getByTestId("customer-balance")).not.toHaveText("Nothing to pay");
    const first = page.getByTestId("open-invoice").filter({ hasText: firstInvoice.invoiceNo });
    // Rs. 3,000 less Rs. 1,000 from the deposit.
    await expect(first).toContainText("Rs. 2,000");
    await expect(first).toContainText("Partially paid");
  });
});
