import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, openFirstCycle } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Meter replaced at 360 px (spec 6.4, 11.2, 11.8; decision 51): the owner records a new
// baseline with the old meter's last reading; the next bill measures from the new meter
// and carries the copies printed on the old one. Its own E2E machine rented to
// cust.perera (initial reading 1,000; Rs. 5,000 for 2,000 copies, Rs. 2.50 above);
// everything is deleted afterwards.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serial = `${E2E_SERIAL_PREFIX}BSL-${run}`;

test.afterAll(async () => {
  await deleteE2eMachines(serial);
});

const asOwner = (page: Page) => signInCached(page, DEMO.ownerLanka, "/owner");

test("the owner records a meter baseline and the next bill uses it", async ({ page }) => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, serial, "MP 2303"), customer, today);
  const ticketId = await openFirstCycle(agreementId);

  await asOwner(page);
  await page.goto(`/owner/agreements/${agreementId}`);
  await page.getByTestId("record-baseline").click();
  await expect(page.getByRole("heading", { name: "New meter baseline" })).toBeVisible();
  await expect(page.getByText("Last known reading: 1,000")).toBeVisible();
  await page.getByLabel("New meter: starting reading").fill("0");
  // Lower than the last reading: refused before anything is saved.
  await page.getByLabel("Old meter: last reading").fill("900");
  await page.getByLabel("What happened?").fill("The counter board was replaced by the technician");
  await page.getByRole("button", { name: "Record new baseline" }).click();
  await expect(page.getByText("Lower than the last B&W reading (1,000)")).toBeVisible();
  await page.getByLabel("Old meter: last reading").fill("1,600");
  await expect(page.getByTestId("carried-BW")).toHaveText("600 copies printed on the old meter will be billed with the next reading.");
  await page.getByRole("button", { name: "Record new baseline" }).click();

  await expect(page).toHaveURL(new RegExp(`/owner/agreements/${agreementId}$`));
  await expect(page.getByTestId("baseline-history")).toContainText("B&W from 0 (was 1,000) · 600 copies on the old meter carried");
  await page.goto(`/owner/tickets/${ticketId}`);
  await expect(page.getByTestId("ticket-timeline")).toContainText("New meter recorded: B&W from 0 (600 copies on the old meter carried)");

  // The next bill: 1,500 on the new meter + 600 on the old = 2,100 copies, 100 above 2,000 = Rs. 5,250.
  await page.goto(`/owner/tickets/${ticketId}/enter`);
  await page.getByLabel("Meter reading").fill("1500");
  await expect(page.getByTestId("reading-preview")).toContainText("2,100 copies");
  await expect(page.getByTestId("reading-preview")).toContainText("0 → 1,500 + 600 on the replaced meter");
  await expect(page.getByTestId("preview-total")).toHaveText("Rs. 5,250");
  await page.getByLabel("Why are you entering it? (shown to the customer)").fill("The customer phoned the new meter reading in");
  await page.getByRole("button", { name: "Save reading" }).click();
  await expect(page).toHaveURL(new RegExp(`/owner/tickets/${ticketId}/review$`));
  await expect(page.getByTestId("review-total")).toHaveText("Rs. 5,250");
});
