import { expect, type Page, test } from "@playwright/test";

import { signIn, signInAndWait } from "./support/auth";
import { DEMO, deleteE2eAccounts, E2E_PREFIX, profileId } from "./support/demo";

// Creates real accounts in the dev project; they are deleted afterwards
// (and by the global setup if a run was interrupted).
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await deleteE2eAccounts();
});

const suffix = Date.now().toString(36);

async function readCredentials(page: Page, title: string) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(title);
  const username = (await dialog.getByTestId("credential-username").textContent())!.trim();
  const password = (await dialog.getByTestId("credential-password").textContent())!.trim();
  // The dialog can only be closed after confirming the details were saved.
  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await dialog.getByLabel("I have saved these details").check();
  await done.click();
  await expect(dialog).toBeHidden();
  return { username, password };
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
}

async function changeStatus(page: Page, verb: "Suspend" | "Reactivate" | "Deactivate", reason: string) {
  await page.getByRole("button", { name: verb }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: verb }).click();
  await expect(dialog).toBeHidden();
}

test.describe("owner manages customers (CUS-01..03)", () => {
  const name = `${E2E_PREFIX} Customer ${suffix}`;
  let customer = { username: "", password: "" };
  let detailUrl = "";

  test("creates a customer and sees the login details once", async ({ page }) => {
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto("/owner/customers/new");
    await page.getByRole("button", { name: "Create customer account" }).click();
    await expect(page.getByText("Name is required.")).toBeVisible();

    await page.getByLabel("Customer name").fill(name);
    await page.getByLabel("Phone").fill("077 111 2233");
    await page.getByRole("button", { name: "Create customer account" }).click();

    customer = await readCredentials(page, "Customer account created");
    expect(customer.username).toBe(`cust.e2e-customer-${suffix}`);
    expect(customer.password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);

    await expect(page).toHaveURL(/\/owner\/customers\/[0-9a-f-]{36}$/);
    detailUrl = page.url();
    await expect(page.getByRole("heading", { name })).toBeVisible();

    await page.goto(`/owner/customers?q=${suffix}`);
    await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  });

  test("the new customer must change the temporary password", async ({ page }) => {
    await signInAndWait(page, customer.username, customer.password, /\/change-password$/);
  });

  test("suspending blocks sign-in with a clear message; reactivate and reset password", async ({ page }) => {
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto(detailUrl);
    await changeStatus(page, "Suspend", "Payments overdue");
    await expect(page.getByText("Suspended", { exact: true }).filter({ visible: true })).toBeVisible();
    await signOut(page);

    await signIn(page, customer.username, customer.password);
    await expect(page.getByText("Your account is suspended. Please contact your provider.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto(detailUrl);
    await changeStatus(page, "Reactivate", "Paid in full");
    await page.getByRole("button", { name: "Reset password" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reset password" }).click();
    const reset = await readCredentials(page, "New temporary password");
    expect(reset.username).toBe(customer.username);
    expect(reset.password).not.toBe(customer.password);
    await signOut(page);

    // The old password no longer works; the new temporary one does, with a forced change.
    await signIn(page, customer.username, customer.password);
    await expect(page.getByText("The username or password is not correct.")).toBeVisible();
    await signInAndWait(page, customer.username, reset.password, /\/change-password$/);
  });

  test("an owner cannot open another owner's customer", async ({ page }) => {
    const otherTenantCustomer = await profileId("cust.jayasuriya"); // Ceylon Office Machines
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto(`/owner/customers/${otherTenantCustomer}`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByText("Jayasuriya")).toHaveCount(0);
  });
});

test.describe("admin manages owners (ADM-01..03)", () => {
  const business = `${E2E_PREFIX} Owner ${suffix}`;
  let owner = { username: "", password: "" };

  test("creates an owner, who must change the password and then set up the company", async ({ page }) => {
    await signInAndWait(page, DEMO.admin.username, DEMO.admin.password, /\/admin$/);
    await page.goto("/admin/owners/new");
    await page.getByLabel("Business name").fill(business);
    await page.getByLabel("Contact person").fill("Test Contact");
    await page.getByLabel("Phone").fill("0112223344");
    await page.getByLabel("Email").fill("e2e-owner@example.com");
    await page.getByRole("button", { name: "Create owner account" }).click();

    owner = await readCredentials(page, "Owner account created");
    expect(owner.username).toBe(`owner.e2e-owner-${suffix}`);
    await expect(page.getByRole("heading", { name: business })).toBeVisible();

    // Edit the details.
    await page.getByLabel("Contact person").fill("Edited Contact");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved")).toBeVisible();
    await signOut(page);

    await signInAndWait(page, owner.username, owner.password, /\/change-password$/);
    const newPassword = "Galle-Fort-2026-new"; // must not contain "e2e", part of the username
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Type the new password again").fill(newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/setup$/);
    owner.password = newPassword;
  });

  test("a suspended owner cannot sign in", async ({ page }) => {
    await signInAndWait(page, DEMO.admin.username, DEMO.admin.password, /\/admin$/);
    await page.goto(`/admin/owners?q=${suffix}`);
    await page.getByRole("link", { name: new RegExp(business) }).click();
    await expect(page.getByRole("heading", { name: business })).toBeVisible();
    await changeStatus(page, "Suspend", "Subscription unpaid");
    await expect(page.getByText("Suspended", { exact: true }).filter({ visible: true })).toBeVisible();
    await signOut(page);

    await signIn(page, owner.username, owner.password);
    await expect(page.getByText("Your account is suspended. Please contact your provider.")).toBeVisible();
  });
});
