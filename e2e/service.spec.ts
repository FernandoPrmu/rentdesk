import { expect, type Page, test } from "@playwright/test";
import sharp from "sharp";

import { signInCached } from "./support/auth";
import { assignMachine, createMachine } from "./support/billing";
import { waitForDashboard } from "./support/dashboard";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";
import { resolvedBreakdown } from "./support/service";

// Service requests at 360 px (SRV-01..09, CP-07; decisions 57-62). cust.silva raises a
// HIGH toner request for a colour machine with a photo from Home; the owner sees it at
// the top, acknowledges, assigns, starts and resolves it; the customer confirms the fix
// and rates it. A second request: the customer says "still not fixed" and it goes back
// to In progress. Each test rents its own E2E machine and deletes everything after.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serials: string[] = [];

test.afterAll(async () => {
  for (const serial of serials) await deleteE2eMachines(serial);
});

const asCustomer = (page: Page) => signInCached(page, DEMO.custSilva, "/customer");
const asOwner = (page: Page) => signInCached(page, DEMO.ownerLanka, "/owner");
/** Next keeps the previous route in the DOM, hidden: only the visible match counts. */
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

test("toner for a colour machine with a photo: owner acknowledges, assigns, resolves; the customer confirms and rates", async ({ page }, info) => {
  const serial = `${E2E_SERIAL_PREFIX}SRV-${run}-${info.repeatEachIndex}`;
  serials.push(serial);
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custSilva.username);
  await assignMachine(owner, await createMachine(owner, serial, "IM C300", "COLOUR"), customer, today, today, true);

  // Customer: Home → Request service; machine, toner colours, urgency, photo.
  await asCustomer(page);
  await page.getByTestId("home-request-service").click();
  await expect(page.getByRole("heading", { name: "Request service" })).toBeVisible();
  await page.getByRole("radio", { name: new RegExp(serial) }).click();
  await page.getByRole("radio", { name: /^Toner/ }).click();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Choose the toner colour(s) you need.")).toBeVisible();
  await page.getByRole("checkbox", { name: "Cyan" }).click();
  await page.getByRole("checkbox", { name: "Magenta" }).click();
  await page.getByLabel("Tell us more").fill("Cyan and magenta are nearly empty");
  await page.getByRole("radio", { name: "High", exact: true }).click();
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 160, b: 200 } } }).jpeg().toBuffer();
  await page.getByTestId("slip-file-input").setInputFiles({ name: "toner.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByTestId("slip-name")).toHaveText("toner.jpg");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByTestId("service-sent")).toBeVisible();
  await page.getByRole("link", { name: "Open the request" }).click();
  await expect(page).toHaveURL(/\/customer\/service\/[0-9a-f-]{36}$/);
  const requestId = page.url().split("/").at(-1)!;
  await expect(shown(page, "service-status")).toHaveText("New");
  await expect(page.getByRole("heading", { name: "Toner: cyan, magenta" })).toBeVisible();
  await expect(shown(page, "service-photo")).toBeVisible();

  // Owner: the HIGH request is on Home, highlighted; the list shows it among the first.
  await asOwner(page);
  await waitForDashboard(page, "home-service");
  const card = shown(page, "home-service");
  await expect(card).toContainText("urgent or high");
  await expect(card.getByRole("link", { name: /Toner: cyan, magenta/ }).first()).toBeVisible();
  await page.goto("/owner/service");
  const first = page.getByRole("list", { name: "Service requests" }).getByTestId("service-card").first();
  await expect(first.getByTestId("urgency-badge")).toBeVisible(); // URGENT or HIGH on top
  await page.goto(`/owner/service/${requestId}`);
  await expect(shown(page, "urgency-badge")).toHaveText("High");
  await expect(shown(page, "service-photo")).toBeVisible();

  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(shown(page, "service-status")).toHaveText("Acknowledged");
  await page.getByLabel("Technician or staff member").fill("Nimal Perera");
  await page.getByLabel("Planned visit").fill(today);
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(shown(page, "service-status")).toHaveText("Assigned");
  await page.getByRole("button", { name: "Start work" }).click();
  await expect(shown(page, "service-status")).toHaveText("In progress");
  await page.getByLabel("Work done").fill("Fitted new cyan and magenta cartridges");
  await page.getByLabel("Parts used").fill("Cyan and magenta toner");
  await page.getByLabel("Cost to you").fill("9500");
  await page.getByRole("button", { name: "Mark as resolved" }).click();
  await expect(shown(page, "service-status")).toHaveText("Resolved");
  await expect(shown(page, "service-timeline")).toContainText("Assigned to Nimal Perera");

  // Customer: Home asks to confirm; confirm the fix, then rate it.
  await asCustomer(page);
  await expect(shown(page, "task-confirm-fix").filter({ hasText: "Toner: cyan, magenta" }).first()).toBeVisible();
  await page.goto(`/customer/service/${requestId}`);
  await expect(shown(page, "service-timeline")).toContainText("Fitted new cyan and magenta cartridges");
  await expect(shown(page, "service-timeline")).not.toContainText("9,500"); // the owner's own cost
  await page.getByRole("button", { name: "Yes, it is fixed" }).click();
  await expect(shown(page, "service-status")).toHaveText("Closed");
  await page.getByRole("radio", { name: "5 stars" }).click();
  await page.getByLabel("Comment").fill("Quick and friendly");
  await page.getByRole("button", { name: "Send rating" }).click();
  await expect(page.getByText("Your rating:")).toBeVisible();
  await expect(shown(page, "rating-form")).toHaveCount(0);

  // Owner: the rating on the request and the average on the customer profile.
  await asOwner(page);
  await page.goto(`/owner/service/${requestId}`);
  await expect(shown(page, "service-rating")).toContainText("Quick and friendly");
  await page.goto(`/owner/customers/${customer}`);
  await expect(shown(page, "customer-rating")).toContainText("Average rating");
});

test("'still not fixed' takes a resolved request back to In progress with the reason", async ({ page }, info) => {
  const serial = `${E2E_SERIAL_PREFIX}SRV2-${run}-${info.repeatEachIndex}`;
  serials.push(serial);
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custSilva.username);
  const machineId = await createMachine(owner, serial, "MP 2555");
  await assignMachine(owner, machineId, customer, today);
  const requestId = await resolvedBreakdown(owner, customer, machineId);

  await asCustomer(page);
  await page.goto(`/customer/service/${requestId}`);
  await expect(shown(page, "service-status")).toHaveText("Resolved");
  await page.getByRole("button", { name: "No, still not fixed" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Reason").fill("The paper still jams in tray 2");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(shown(page, "service-status")).toHaveText("In progress");
  await expect(shown(page, "service-timeline")).toContainText("Still not fixed: reopened");

  await asOwner(page);
  await page.goto(`/owner/service/${requestId}`);
  await expect(shown(page, "service-status")).toHaveText("In progress");
  await expect(page.getByText("Reopened 1 time(s)")).toBeVisible();
  await expect(shown(page, "service-timeline")).toContainText("The paper still jams in tray 2");
  await expect(page.getByRole("button", { name: "Mark as resolved" })).toBeVisible();
});
