import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine, openFirstCycle } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";
import { pdfText } from "./support/pdf";

// Meter reading with the live camera and the owner's review at 360 px (INV-01..09,
// CP-02, CP-03), using Chromium's fake camera. A denied camera shows the help; the
// customer photographs the meter, types the reading, sees the preview and sends it;
// the owner rejects it with a reason; the customer sees why and sends again; the
// owner confirms; the customer sees "Awaiting payment", opens Bills and downloads the
// invoice PDF (INV-09, CP-05). The machine, its ticket, the uploaded photos and the
// invoice PDFs are deleted afterwards.
test.describe.configure({ mode: "serial" });
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera"],
});

const serial = `${E2E_SERIAL_PREFIX}MTR-${Date.now().toString(36).toUpperCase()}`;
const MODEL = "MP 3055";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
let ticketId = "";

test.beforeAll(async () => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, serial, MODEL), customer, today);
  ticketId = await openFirstCycle(agreementId);
});

test.afterAll(async () => {
  await deleteE2eMachines(serial);
});

const signIn = (page: Page, who: "customer" | "owner") =>
  who === "customer" ? signInCached(page, DEMO.custPerera, "/customer") : signInCached(page, DEMO.ownerLanka, "/owner");

/** Live camera → photo → reading → preview → send. The initial reading is 1,000. */
async function sendReading(page: Page, reading: string, total: string) {
  await page.getByRole("button", { name: "Open camera" }).click();
  const video = page.getByTestId("camera-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  // The shutter waits for real frames (decision 37), then the fake camera's frame passes the check.
  await expect(page.getByRole("button", { name: "Take photo" })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.getByTestId("meter-photo")).toBeVisible();
  await expect(page.getByTestId("bad-photo")).toHaveCount(0);
  // No gallery or file picker anywhere on the page (INV-03).
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  await page.getByLabel("Meter reading").fill(reading);
  await expect(page.getByTestId("preview-total")).toHaveText(total);
  await page.getByRole("button", { name: "Send reading" }).click();
  await expect(page.getByTestId("meter-sent")).toBeVisible({ timeout: 30_000 });
}

test.describe("meter reading with the live camera, and the owner's review", () => {
  test("a denied camera shows step-by-step help, never a file picker", async ({ page }) => {
    // The browser refuses the camera, as when the customer tapped "Block".
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });
    await signIn(page, "customer");
    await page.goto(`/customer/tickets/${ticketId}/meter`);
    await page.getByRole("button", { name: "Open camera" }).click();
    const help = page.getByTestId("camera-help");
    await expect(help).toContainText("Allow the camera");
    await expect(help).toContainText("Android (Chrome)");
    await expect(help).toContainText("iPhone (Safari)");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test("the customer photographs the meter, types the reading, sees the preview and sends it", async ({ page }) => {
    await signIn(page, "customer");
    const task = page.getByTestId("task-meter").filter({ hasText: MODEL });
    await task.getByRole("link", { name: "Enter meter reading" }).click();
    await expect(page).toHaveURL(new RegExp(`/customer/tickets/${ticketId}/meter$`));

    // A lower reading blocks with a clear message.
    await page.getByLabel("Meter reading").fill("900");
    await expect(page.getByText("The B&W reading is lower than last time.", { exact: false })).toBeVisible();

    // The typed reading survives a reload (the photo does not).
    await page.getByLabel("Meter reading").fill("3600");
    await page.reload();
    await expect(page.getByLabel("Meter reading")).toHaveValue("3600");

    // 2,600 copies: Rs. 5,000 + 600 x Rs. 2.50 (spec 6.3 mono case 2).
    await sendReading(page, "3600", "Rs. 6,500");
    await page.goto(`/customer/tickets/${ticketId}`);
    await expect(page.getByTestId("customer-ticket-status")).toHaveText("Pending owner review");
  });

  test("the owner rejects it with a reason; the customer sees why and sends again", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto("/owner/approvals");
    await page.locator(`a[href="/owner/tickets/${ticketId}/review"]`).first().click();
    await expect(page.getByTestId("review-photo")).toBeVisible();
    await expect(page.getByTestId("review-readings")).toContainText("3,600");
    await expect(page.getByTestId("review-total")).toHaveText("Rs. 6,500");

    await page.getByRole("button", { name: "Reject reading" }).click();
    await page.getByLabel("Reason").fill("The photo is blurry, please take it again");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(page.getByText("Rejected. The customer was asked to send it again.")).toBeVisible();

    await signIn(page, "customer");
    await page.goto(`/customer/tickets/${ticketId}`);
    await expect(page.getByTestId("rejection-reason")).toContainText("The photo is blurry, please take it again");
    await page.getByRole("link", { name: "Send the reading again" }).click();
    await sendReading(page, "3500", "Rs. 6,250");
  });

  test("the owner confirms; the customer sees Awaiting payment and the bill", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto(`/owner/tickets/${ticketId}/review`);
    await expect(page.getByTestId("review-total")).toHaveText("Rs. 6,250");
    await page.getByRole("button", { name: "Confirm invoice" }).click();
    await expect(page.getByText(/^Invoice INV-\d+ sent to the customer$/)).toBeVisible();

    await signIn(page, "customer");
    await page.goto(`/customer/tickets/${ticketId}`);
    await expect(page.getByTestId("customer-ticket-status")).toHaveText("Awaiting payment");
    await expect(page.getByTestId("customer-bill")).toContainText("Rs. 6,250 to pay");
    await expect(page.getByTestId("customer-timeline")).toContainText("Reading not accepted");
  });

  test("the customer opens Bills and downloads the invoice PDF; the owner sees its version history", async ({ page }) => {
    await signIn(page, "customer");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Bills" }).last().click();
    await expect(page).toHaveURL(/\/customer\/bills$/);
    const row = page.getByRole("region", { name: "To pay" }).getByTestId("invoice-row").filter({ hasText: MODEL });
    await expect(row).toContainText("Rs. 6,250.00");
    await row.click();

    await expect(page.getByTestId("invoice-total")).toHaveText("Rs. 6,250.00");
    await expect(page.getByTestId("invoice-line")).toHaveCount(2);
    const invoiceNo = (await page.getByRole("heading", { level: 1 }).textContent())?.trim() ?? "";
    expect(invoiceNo).toMatch(/^INV-\d+$/);
    const download = page.getByTestId("download-pdf");
    await expect(download).toHaveAttribute("target", "_blank");

    // The link opens a new tab (headless Chrome downloads the PDF there); the same link,
    // followed here, redirects to a short-lived signed URL of the private file.
    const [tab] = await Promise.all([page.waitForEvent("popup"), download.click()]);
    await tab.close();
    const href = (await download.getAttribute("href")) ?? "";
    const redirect = await page.request.get(href, { maxRedirects: 0 });
    expect(redirect.status()).toBe(303);
    expect(redirect.headers().location).toMatch(/\/storage\/v1\/object\/sign\/invoices\//);
    const response = await page.request.get(href);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    const text = await pdfText(await response.body());
    expect(text).toContain(invoiceNo);
    expect(text).toContain("Rs. 6,250.00");
    expect(text).toContain("Monthly commitment");
    expect(text).toContain(serial);

    await signIn(page, "owner");
    await page.goto("/owner/invoices");
    await page.getByTestId("invoice-row").filter({ hasText: invoiceNo }).click();
    await expect(page.getByTestId("pdf-version")).toHaveCount(1);
    await expect(page.getByTestId("pdf-version")).toContainText("Version 1 · Issued");
    await expect(page.getByTestId("download-pdf")).toBeVisible();
  });
});
