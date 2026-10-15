import { expect, type Page, test } from "@playwright/test";

import { signInCached } from "./support/auth";
import { assignMachine, auditCount, createMachine, openFirstCycle } from "./support/billing";
import { DEMO, deleteE2eMachines, E2E_SERIAL_PREFIX, profileId } from "./support/demo";

// Ticket messages at 360 px (TKT-11, CP-06; decision 50): the customer writes (camera
// trouble, spec 11.2), changes the message within 5 minutes, the owner answers, and the
// customer sees the answer with the company's name. Its own E2E machine and ticket for
// cust.perera; everything is deleted afterwards.
test.describe.configure({ mode: "serial" });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
const run = Date.now().toString(36).toUpperCase();
const serial = `${E2E_SERIAL_PREFIX}MSG-${run}`;

const serials = [serial];

test.afterAll(async () => {
  for (const s of serials) await deleteE2eMachines(s);
});

const asCustomer = (page: Page) => signInCached(page, DEMO.custPerera, "/customer");
const asOwner = (page: Page) => signInCached(page, DEMO.ownerLanka, "/owner");

test("a message thread both ways: customer writes and edits, owner answers", async ({ page }) => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, serial, "MP 2302"), customer, today);
  const ticketId = await openFirstCycle(agreementId);

  await asCustomer(page);
  await page.goto(`/customer/tickets/${ticketId}`);
  const thread = page.getByTestId("comment-thread");
  await expect(thread).toContainText("No messages yet.");
  await thread.getByLabel("Write a message").fill("මීටරය");
  await thread.getByRole("button", { name: "Send message" }).click();
  await expect(thread.getByRole("alert")).toHaveText("Please use English letters only.");
  await thread.getByLabel("Write a message").fill("My camera does not open. Can you enter the reading?");
  await thread.getByRole("button", { name: "Send message" }).click();
  const mine = thread.getByTestId("comment").filter({ hasText: "My camera does not open" });
  await expect(mine).toContainText("You");
  await expect(thread.getByLabel("Write a message")).toHaveValue("");

  // The author may change it for 5 minutes.
  await mine.getByRole("button", { name: "Edit" }).click();
  await thread.getByLabel("Change the message").fill("My camera does not open. Please enter the reading: 1,250.");
  await thread.getByRole("button", { name: "Save" }).click();
  await expect(thread.getByTestId("comment-body")).toHaveText("My camera does not open. Please enter the reading: 1,250.");
  await expect(thread.getByTestId("comment")).toContainText("edited");

  // The owner sees it under the customer's name, and answers.
  await asOwner(page);
  await page.goto(`/owner/tickets/${ticketId}`);
  const ownerThread = page.getByTestId("comment-thread");
  const theirs = ownerThread.getByTestId("comment").filter({ hasText: "Please enter the reading: 1,250." });
  await expect(theirs).toBeVisible();
  await expect(theirs.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await ownerThread.getByLabel("Write a message").fill("Thank you, I will enter 1,250 for you today.");
  await ownerThread.getByRole("button", { name: "Send message" }).click();
  await expect(ownerThread.getByTestId("comment").filter({ hasText: "I will enter 1,250" })).toContainText("You");

  // The customer sees the answer from the rental company.
  await asCustomer(page);
  await page.goto(`/customer/tickets/${ticketId}`);
  const answer = page.getByTestId("comment-thread").getByTestId("comment").filter({ hasText: "I will enter 1,250" });
  await expect(answer).toBeVisible();
  await expect(answer).not.toContainText("You");
  await expect(page.getByTestId("comment-thread").getByTestId("comment")).toHaveCount(2);
});

test("another customer opening this ticket gets 'not found', and the attempt is logged (11.7)", async ({ page }) => {
  const owner = await profileId(DEMO.ownerLanka.username);
  const customer = await profileId(DEMO.custPerera.username);
  const silva = await profileId(DEMO.custSilva.username);
  const agreementId = await assignMachine(owner, await createMachine(owner, `${serial}-2`, "MP 2304"), customer, today);
  serials.push(`${serial}-2`);
  const ticketId = await openFirstCycle(agreementId);
  await signInCached(page, DEMO.custSilva, "/customer");
  await page.goto(`/customer/tickets/${ticketId}`);
  await expect(page.getByRole("heading", { name: "We could not find this page" })).toBeVisible();
  await expect.poll(() => auditCount("ACCESS_DENIED", ticketId, silva)).toBe(1);
});
