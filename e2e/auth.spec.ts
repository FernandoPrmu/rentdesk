import { expect, test } from "@playwright/test";

import { signIn, signInAndWait } from "./support/auth";
import { DEMO } from "./support/demo";

const GENERIC_ERROR = "The username or password is not correct.";

test.describe("login (AUTH-06, AUTH-08)", () => {
  test("an admin lands on the admin portal", async ({ page }) => {
    await signInAndWait(page, DEMO.admin.username, DEMO.admin.password, /\/admin$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("an owner lands on the owner portal", async ({ page }) => {
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await expect(page.getByRole("heading", { name: /^Hello/ })).toBeVisible();
    await expect(page.getByText("Lanka Copy Solutions").first()).toBeVisible();
  });

  test("a customer lands on the customer home with what to do now", async ({ page }) => {
    await signInAndWait(page, DEMO.custPerera.username, DEMO.custPerera.password, /\/customer$/);
    await expect(page.getByRole("heading", { name: "What you need to do now" })).toBeVisible();
    // Bottom navigation for customers.
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const item of ["Home", "Machines", "Bills", "Help"]) {
      await expect(nav.getByRole("link", { name: item })).toBeVisible();
    }
  });

  test("a wrong password and an unknown username show the same generic error", async ({ page }) => {
    await signIn(page, DEMO.custSilva.username, "not-the-password");
    await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await signIn(page, "e2e.nobody", "not-the-password");
    await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
  });

  test("signing out returns to the login page", async ({ page }) => {
    await signInAndWait(page, DEMO.custPerera.username, DEMO.custPerera.password, /\/customer$/);
    await page.getByRole("link", { name: "Help" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/customer");
    await expect(page).toHaveURL(/\/login\?next=%2Fcustomer$/);
  });
});

test.describe("route guards (AUTH-06)", () => {
  test("an owner cannot open the admin portal", async ({ page }) => {
    await signInAndWait(page, DEMO.ownerLanka.username, DEMO.ownerLanka.password, /\/owner$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto("/admin/owners");
    await expect(page).toHaveURL(/\/owner$/);
  });

  test("a customer cannot open the owner portal", async ({ page }) => {
    await signInAndWait(page, DEMO.custPerera.username, DEMO.custPerera.password, /\/customer$/);
    await page.goto("/owner");
    await expect(page).toHaveURL(/\/customer$/);
    await page.goto("/owner/customers");
    await expect(page).toHaveURL(/\/customer$/);
  });

  test("a signed-out visitor is sent to the login page", async ({ page }) => {
    await page.goto("/admin/owners");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fowners$/);
  });
});
