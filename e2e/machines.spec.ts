import { expect, type Page, test } from "@playwright/test";

import { signInAndWait } from "./support/auth";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX } from "./support/demo";

// One machine goes through its whole life at 360 px: register, assign to a seed
// customer, seen by that customer, price change from the next cycle, return.
// The machine and its agreement are deleted afterwards (and by the global setup).
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await deleteE2eMachines();
});

const serial = `${E2E_SERIAL_PREFIX}${Date.now().toString(36).toUpperCase()}`;
let machineUrl = "";
let agreementUrl = "";

/** 100 days ago: a rental that is already running when it is entered. */
const pastStart = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);

const signInOwner = (page: Page) => signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);

test.describe("machines and agreements (MAC-01..04, AGR-01..02)", () => {
  test("owner registers a machine", async ({ page }) => {
    await signInOwner(page);
    await page.getByRole("link", { name: "Machines" }).first().click();
    await page.getByRole("link", { name: "New machine" }).click();

    await page.getByRole("button", { name: "Register machine" }).click();
    await expect(page.getByText("Brand is required.")).toBeVisible();

    await page.getByLabel("Brand").fill("Ricoh");
    await page.getByLabel("Model").fill("MP 2555");
    await page.getByLabel("Serial number").fill(serial);
    // Next keeps the previous page (with its "Type" filter) hidden in the DOM; roles skip hidden elements.
    await page.getByRole("combobox", { name: "Type" }).selectOption("MONO");
    // No counter maximum: a lower closing reading cannot pass as a rollover below.
    await page.getByRole("button", { name: "Register machine" }).click();

    await expect(page).toHaveURL(/\/owner\/machines\/[0-9a-f-]{36}$/);
    machineUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: "Ricoh MP 2555" })).toBeVisible();
    await expect(page.getByText("Available", { exact: true }).filter({ visible: true })).toBeVisible();

    // Found by serial number in the list (cards at 360 px).
    await page.goto(`/owner/machines?q=${serial}`);
    await expect(page.getByRole("list", { name: "Machines" }).getByRole("link")).toHaveCount(1);
  });

  test("owner assigns it to a customer with terms and a first billing date", async ({ page }) => {
    await signInOwner(page);
    await page.goto(machineUrl);
    await page.getByRole("link", { name: "Assign to a customer" }).click();

    await page.getByLabel("Customer", { exact: true }).selectOption({ label: "Silva Stationers" });
    await page.getByLabel("Installation location").fill("Front office");
    // A rental that is already running: start in the past, first billing date stays in the future.
    await page.getByLabel("Start date").fill(pastStart);
    await expect(page.getByTestId("first-billing-preview")).toContainText("First meter reading request on");
    await page.getByLabel("B&W counter", { exact: true }).fill("12,500");
    await page.getByLabel("Monthly commitment").fill("5,000");
    await page.getByLabel("Included B&W copies").fill("2000");
    await page.getByLabel("B&W excess rate (per copy)").fill("2.50");

    // Server-side validation: a negative reading is refused with a clear message.
    await page.getByLabel("B&W counter", { exact: true }).fill("-5");
    await page.getByRole("button", { name: "Assign machine" }).click();
    await expect(page.getByText("Initial B&W reading must be a whole number (0 or more).")).toBeVisible();
    await page.getByLabel("B&W counter", { exact: true }).fill("12,500");
    await page.getByRole("button", { name: "Assign machine" }).click();

    await expect(page).toHaveURL(/\/owner\/agreements\/[0-9a-f-]{36}\?assigned=1$/);
    agreementUrl = new URL(page.url()).pathname;
    await expect(page.getByText(/^Machine assigned\./)).toBeVisible();
    await expect(page.getByTestId("first-billing-date")).toBeVisible();
    await expect(page.getByText("Rs. 5,000", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByText("Rs. 2.50 per copy")).toBeVisible();

    await page.goto(machineUrl);
    await expect(page.getByText("Rented", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Silva Stationers" })).toBeVisible();
  });

  test("the customer sees it in the Machines tab", async ({ page }) => {
    await signInAndWait(page, DEMO.custSilva.username, DEMO.custSilva.password, /\/customer$/);
    await page.getByRole("link", { name: "Machines" }).first().click();
    await expect(page).toHaveURL(/\/customer\/machines$/);
    const card = page.getByTestId("agreement-card").filter({ hasText: serial });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Ricoh MP 2555");
    await expect(card).toContainText("Front office");
    await expect(card).toContainText("Rs. 5,000 every 30 days");
    await expect(card).toContainText("Next meter reading");
    // Another customer's machines never show up.
    await expect(page.getByText("LCS-C-001")).toHaveCount(0);
  });

  test("owner changes the price: it applies from the next cycle", async ({ page }) => {
    await signInOwner(page);
    await page.goto(agreementUrl);
    await expect(page.getByTestId("terms-effective-note")).toContainText("from the next cycle");

    await page.getByLabel("Monthly commitment").fill("6,000");
    await page.getByLabel("Note for the history").fill("New price list");
    await page.getByRole("button", { name: "Save terms" }).click();

    await expect(page.getByTestId("pending-terms")).toContainText("from the next cycle");
    // Current terms are unchanged until then; the history shows both versions.
    await expect(page.getByText("Rs. 5,000", { exact: true }).filter({ visible: true })).toBeVisible();
    const history = page.getByRole("list", { name: "Terms history" });
    await expect(history.getByText("Version 2")).toBeVisible();
    await expect(history).toContainText("Rs. 6,000 / cycle");
    await expect(history).toContainText("New price list");
    await expect(history.getByText("Version 1")).toBeVisible();
  });

  test("owner returns it with a closing reading and a reason", async ({ page }) => {
    await signInOwner(page);
    await page.goto(machineUrl);
    await page.getByRole("link", { name: "Return", exact: true }).click();

    await page.getByLabel("Closing B&W reading").fill("12,000");
    await page.getByLabel("Reason for the return").fill("Customer moved to a bigger machine");
    await page.getByRole("button", { name: "Return machine" }).click();
    await expect(page.getByText(/lower than the last reading 12500/)).toBeVisible();

    await page.getByLabel("Closing B&W reading").fill("13,100");
    await page.getByRole("button", { name: "Return machine" }).click();
    await expect(page).toHaveURL(/\?returned=1$/);
    await expect(page.getByText("The machine was returned and is available again.")).toBeVisible();
    await expect(page.getByText("Available", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByText("Closing B&W 13,100")).toBeVisible();
  });

  test("return is blocked while a billing ticket is open", async ({ page }) => {
    await signInOwner(page);
    // Seed: Perera Printers' colour machine has a ticket waiting for the meter reading.
    await page.goto("/owner/machines?q=LCS-C-001");
    await page.getByRole("list", { name: "Machines" }).getByRole("link").first().click();
    await page.getByRole("link", { name: "Return", exact: true }).click();
    await expect(page.getByText("This machine cannot be returned yet")).toBeVisible();
    await expect(page.getByText(/Billing ticket for cycle 1: Meter requested/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Return machine" })).toHaveCount(0);
  });
});
