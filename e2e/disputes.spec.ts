import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, invoiceIdByNo, invoiceState, issueFirstInvoice, ticketIds } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Disputes at 360 px (spec 11.4, CP-06; decisions 47-48): the customer disputes a bill
// from the bill page with a photo; the owner sees the dispute and the reading on record,
// and answers with a credit; the customer sees the lower bill and the answer. The test
// rents its own E2E machine to cust.perera (a Rs. 5,000 bill) and deletes everything after.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serial = `${E2E_SERIAL_PREFIX}DSP-${run}`;

test.afterAll(async () => {
  await deleteE2eMachines(serial);
});

const asCustomer = (page: Page) => signInCached(page, DEMO.custPerera, "/customer");
const asOwner = (page: Page) => signInCached(page, DEMO.ownerLanka, "/owner");

test("the customer disputes a bill with a photo; the owner gives a credit; the customer sees the lower bill", async ({ page }) => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  // Its own model: other specs filter cust.perera's Home by theirs.
  const agreementId = await assignMachine(owner, await createMachine(owner, serial, "MP 2301"), customer, today);
  const { invoiceNo } = await issueFirstInvoice(agreementId, 100);
  const invoiceId = await invoiceIdByNo(owner, invoiceNo);
  const [ticketId] = await ticketIds(agreementId);

  // Customer: Bill page -> Dispute this bill, with a reason and a photo from the phone.
  await asCustomer(page);
  await page.goto(`/customer/bills/${invoiceId}`);
  await expect(page.getByTestId("invoice-amount")).toHaveText("Rs. 5,000.00");
  await page.getByTestId("dispute-this-bill").click();
  await expect(page.getByRole("heading", { name: "Dispute this bill" })).toBeVisible();
  await page.getByRole("button", { name: "Send dispute" }).click();
  await expect(page.getByText("Tell your rental company what is wrong with the bill.")).toBeVisible();
  await page.getByLabel("What is wrong with the bill?").fill("The machine was broken for a week; we could not print.");
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
  await page.getByTestId("slip-file-input").setInputFiles({ name: "machine.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByTestId("slip-name")).toHaveText("machine.jpg");
  await page.getByRole("button", { name: "Send dispute" }).click();
  await expect(page.getByTestId("dispute-sent")).toBeVisible();
  await page.getByRole("link", { name: "Open the ticket" }).click();
  await expect(page.getByTestId("customer-ticket-status")).toHaveText("Disputed");
  await expect(page.getByTestId("dispute-status")).toHaveText("Being looked at");
  await expect(page.getByTestId("dispute-reason")).toHaveText("The machine was broken for a week; we could not print.");
  // Once per bill (decision 47): the bill page no longer offers it.
  await page.goto(`/customer/bills/${invoiceId}`);
  await expect(page.getByTestId("dispute-this-bill")).toHaveCount(0);
  await expect(page.getByTestId("pay-this-bill")).toHaveCount(0);

  // Owner: the dispute, its photo, the reading on record; answer with a Rs. 1,500 credit.
  await asOwner(page);
  await page.goto(`/owner/tickets/${ticketId}`);
  const card = page.getByTestId("dispute-card");
  await expect(card.getByTestId("dispute-status")).toHaveText("Waiting for your answer");
  await expect(card.getByRole("link", { name: "Open the photo" })).toBeVisible();
  await expect(card.getByTestId("reading-record")).toContainText("1,000 → 1,100");
  await card.getByRole("button", { name: "Give a credit" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Credit (Rs.)").fill("1500");
  await dialog.getByLabel("Reason").fill("Machine out of order for a week");
  await dialog.getByRole("button", { name: "Give credit" }).click();
  await expect(page.getByText("Credit given. The customer was told.")).toBeVisible();
  await expect(page.getByTestId("dispute-status")).toHaveText("Credit given");
  await expect(page.getByTestId("dispute-answer")).toContainText("Rs. 1,500");
  await expect(page.getByTestId("ticket-timeline")).toContainText("Credit of Rs. 1,500 given for the dispute");
  expect(await invoiceState(invoiceId)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: 350_000 });

  // Customer: the bill is Rs. 3,500 now, with the credit line, and payable again.
  await asCustomer(page);
  await page.goto(`/customer/bills/${invoiceId}`);
  await expect(page.getByTestId("invoice-amount")).toHaveText("Rs. 3,500.00");
  await expect(page.getByTestId("invoice-line").filter({ hasText: "Credit given (dispute)" })).toContainText("-Rs. 1,500.00");
  await expect(page.getByTestId("pay-this-bill")).toBeVisible();
  await page.goto(`/customer/tickets/${ticketId}`);
  await expect(page.getByTestId("dispute-status")).toHaveText("Credit given");
  await expect(page.getByTestId("dispute-answer")).toContainText("Machine out of order for a week");
});
