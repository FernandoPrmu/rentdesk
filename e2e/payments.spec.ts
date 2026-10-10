import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, invoiceIdByNo, invoiceState, issueFirstInvoice } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";
import { pdfText } from "./support/pdf";

// Payments at 360 px (PAY-02..07, PAY-11, TKT-10, CP-04, CP-05): the customer sends a
// slip chosen from the phone's files, the owner accepts it and the customer downloads
// the receipt; a part payment then the rest; a rejected slip sent again (flagged as a
// possible duplicate); a cash payment recorded by the owner, then reversed. Each test
// rents its own E2E machine to cust.fernando (a Rs. 5,000 bill); everything it made,
// slip and receipt files included, is deleted afterwards.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serials: string[] = [];

test.afterAll(async () => {
  for (const serial of serials) await deleteE2eMachines(serial);
});

/** A Rs. 5,000 bill for cust.fernando on a new E2E machine. */
async function newBill(tag: string): Promise<{ invoiceId: string; invoiceNo: string }> {
  const serial = `${E2E_SERIAL_PREFIX}PAY-${tag}-${run}`;
  serials.push(serial);
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custFernando.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, serial), customer, today);
  const { invoiceNo } = await issueFirstInvoice(agreementId, 100);
  return { invoiceId: await invoiceIdByNo(owner, invoiceNo), invoiceNo };
}

/** A real, distinct JPEG (each test's slip has its own fingerprint unless it is sent twice on purpose). */
async function slipImage(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 480, height: 320, channels: 3, background: { r: (seed * 53) % 255, g: (seed * 97) % 255, b: 200 } } })
    .composite([{ input: Buffer.from(`<svg width="480" height="320"><text x="20" y="160" font-size="40">Bank slip ${seed}</text></svg>`) }])
    .jpeg()
    .toBuffer();
}

const asCustomer = (page: Page) => signInCached(page, DEMO.custFernando, "/customer");
const asOwner = (page: Page) => signInCached(page, DEMO.ownerLanka, "/owner");

/** The customer pays from the bill page with a file from the phone; returns the payment id. */
async function paySlip(page: Page, invoiceId: string, o: { slip: Buffer; reference: string; amount?: string; expectDuplicate?: boolean }) {
  await page.goto(`/customer/bills/${invoiceId}`);
  await page.getByTestId("pay-this-bill").click();
  await expect(page.getByRole("heading", { name: "Send a payment slip" })).toBeVisible();
  if (o.amount) await page.getByRole("textbox", { name: "Amount paid" }).fill(o.amount);
  await page.getByRole("textbox", { name: "Bank reference" }).fill(o.reference);
  await page.getByTestId("slip-file-input").setInputFiles({ name: "slip.jpg", mimeType: "image/jpeg", buffer: o.slip });
  await expect(page.getByTestId("slip-name")).toHaveText("slip.jpg");
  await expect(page.getByTestId("pay-plan")).toBeVisible();
  await page.getByRole("button", { name: "Send payment slip" }).click();
  if (o.expectDuplicate) {
    await expect(page.getByRole("alertdialog")).toContainText("Possible duplicate: the same slip file");
    await page.getByRole("button", { name: "Send anyway" }).click();
  }
  await expect(page).toHaveURL(/\/customer\/payments\/[0-9a-f-]{36}\?sent=1$/);
  await expect(page.getByTestId("payment-sent")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Receipt download: a 60-second signed link to the private receipts bucket; returns the PDF text. */
async function receiptText(page: Page): Promise<string> {
  const href = (await page.getByTestId("download-receipt").getAttribute("href")) ?? "";
  const redirect = await page.request.get(href, { maxRedirects: 0 });
  expect(redirect.status()).toBe(303);
  expect(redirect.headers()["location"]).toContain("/storage/v1/object/sign/receipts/");
  const pdf = await page.request.get(redirect.headers()["location"]);
  expect(pdf.ok()).toBe(true);
  return pdfText(await pdf.body());
}

test.describe("payments (PAY-02..07, TKT-10)", () => {
  test("the customer sends a slip from the gallery; the owner accepts it; the customer downloads the receipt", async ({ page }) => {
    const bill = await newBill("ACC");
    await asCustomer(page);
    const paymentId = await paySlip(page, bill.invoiceId, { slip: await slipImage(1), reference: `E2E-${run}-1` });
    await expect(page.getByTestId("payment-status")).toHaveText("Being checked");

    await asOwner(page);
    await page.goto(`/owner/payments/${paymentId}`);
    await expect(page.getByTestId("payment-reference")).toHaveText(`E2E-${run}-1`);
    await expect(page.getByTestId("review-photo")).toBeVisible(); // the slip, from a short signed link
    await expect(page.getByTestId("verify-plan")).toContainText(`Pays ${bill.invoiceNo} in full`);
    await page.getByRole("button", { name: "Accept Rs. 5,000" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Accepted");
    await expect(page.getByTestId("download-receipt")).toBeVisible();
    expect(await invoiceState(bill.invoiceId)).toMatchObject({ status: "PAID", paid: 500_000 });

    await asCustomer(page);
    await page.goto(`/customer/payments/${paymentId}`);
    await expect(page.getByTestId("payment-status")).toHaveText("Accepted");
    const text = await receiptText(page);
    expect(text).toContain("RECEIPT");
    expect(text).toContain(bill.invoiceNo);
    expect(text).toContain("Rs. 5,000.00");
    expect(text).toContain(`E2E-${run}-1`);
    // The payment history lists it with its receipt.
    await page.goto("/customer/payments");
    await expect(page.getByTestId("payment-row").filter({ hasText: bill.invoiceNo })).toContainText("Accepted");
  });

  test("accepted as a part payment (less arrived than the slip says); the rest is paid with a second slip", async ({ page }) => {
    const bill = await newBill("PART");
    await asCustomer(page);
    const first = await paySlip(page, bill.invoiceId, { slip: await slipImage(2), reference: `E2E-${run}-2` });

    await asOwner(page);
    await page.goto(`/owner/payments/${first}`);
    await page.getByRole("button", { name: "Received less" }).click();
    await page.getByRole("textbox", { name: "Amount you received" }).fill("2,000");
    await expect(page.getByTestId("verify-plan")).toContainText(`Rs. 2,000 of ${bill.invoiceNo}`);
    await page.getByRole("button", { name: "Accept Rs. 2,000" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Part payment");
    expect(await invoiceState(bill.invoiceId)).toMatchObject({ status: "PARTIALLY_PAID", paid: 200_000 });

    await asCustomer(page);
    await page.goto(`/customer/bills/${bill.invoiceId}`);
    await expect(page.getByTestId("invoice-amount")).toHaveText("Rs. 3,000.00");
    // The pay page fills in what is left.
    const second = await paySlip(page, bill.invoiceId, { slip: await slipImage(3), reference: `E2E-${run}-3` });
    expect(second).not.toBe(first);

    await asOwner(page);
    await page.goto(`/owner/payments/${second}`);
    await page.getByRole("button", { name: "Accept Rs. 3,000" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Accepted");
    expect(await invoiceState(bill.invoiceId)).toMatchObject({ status: "PAID", paid: 500_000 });
  });

  test("a rejected slip comes back with the reason; the customer sends it again (flagged as a possible duplicate)", async ({ page }) => {
    const bill = await newBill("REJ");
    const slip = await slipImage(4);
    await asCustomer(page);
    const first = await paySlip(page, bill.invoiceId, { slip, reference: `E2E-${run}-4` });

    await asOwner(page);
    await page.goto(`/owner/payments/${first}`);
    await page.getByRole("button", { name: "Reject" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(dialog).toContainText("Write a reason");
    await page.getByLabel("Reason").fill("The amount is not in our account yet");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Not accepted");
    expect((await invoiceState(bill.invoiceId)).status).toBe("AWAITING_PAYMENT");

    await asCustomer(page);
    await page.goto(`/customer/payments/${first}`);
    await expect(page.getByTestId("reject-reason")).toContainText("The amount is not in our account yet");
    // The same slip again: the customer is warned, sends it anyway, and the owner sees the flag.
    const second = await paySlip(page, bill.invoiceId, { slip, reference: `E2E-${run}-4B`, expectDuplicate: true });

    await asOwner(page);
    await page.goto(`/owner/payments/${second}`);
    await expect(page.getByTestId("duplicate-notice")).toContainText("Possible duplicate: the same slip file");
    await page.getByRole("button", { name: "Accept Rs. 5,000" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Accepted");
  });

  test("the owner records a cash payment, then reverses it (a returned payment): the bill is owed again", async ({ page }) => {
    const bill = await newBill("CASH");
    const customer = await profileId(DEMO.custFernando.username);
    await asOwner(page);
    await page.goto(`/owner/payments/new?customer=${customer}`);
    await page.getByRole("checkbox", { name: `Pays ${bill.invoiceNo}` }).check();
    await expect(page.getByRole("textbox", { name: "Amount received" })).toHaveValue("5000");
    await page.getByRole("textbox", { name: "Receipt book number" }).fill("Book 7, page 12");
    await expect(page.getByTestId("record-plan")).toContainText(`Pays ${bill.invoiceNo} in full`);
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page).toHaveURL(/\/owner\/payments\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("payment-status")).toHaveText("Accepted");
    await expect(page.getByTestId("download-receipt")).toBeVisible();
    expect(await invoiceState(bill.invoiceId)).toMatchObject({ status: "PAID", paid: 500_000 });

    await page.getByRole("button", { name: "Reverse payment" }).click();
    await page.getByLabel("Reason").fill("Cash was counterfeit");
    await page.getByRole("alertdialog").getByRole("button", { name: "Reverse payment" }).click();
    await expect(page.getByTestId("payment-status")).toHaveText("Reversed");
    await expect(page.getByText("Reversed: Cash was counterfeit")).toBeVisible();
    expect(await invoiceState(bill.invoiceId)).toMatchObject({ status: "AWAITING_PAYMENT", paid: 0 });
    // The receipt now says REVERSED (a new version).
    const text = await receiptText(page);
    expect(text).toContain("REVERSED");
    expect(text).toContain("Cash was counterfeit");

    await asCustomer(page);
    await page.goto(`/customer/bills/${bill.invoiceId}`);
    await expect(page.getByTestId("pay-this-bill")).toBeVisible();
  });
});
