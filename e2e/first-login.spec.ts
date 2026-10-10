import { expect, test } from "@playwright/test";

import { signInAndWait } from "./support/auth";
import { DEMO, restoreDemoState } from "./support/demo";

// These tests change seed accounts. They run one after the other and put the
// accounts back afterwards (global setup/teardown also restores them).
test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  // Not the invoice template: invoice-template.spec.ts runs in parallel and owns it.
  await restoreDemoState({ invoiceTemplate: false });
});

test("cust.bandara must change the temporary password before anything else (AUTH-03)", async ({ page }) => {
  await signInAndWait(page, DEMO.custBandara.username, DEMO.custBandara.password, /\/change-password$/);
  await expect(page.getByRole("heading", { name: "Choose your own password" })).toBeVisible();

  // Every other page sends the user back here.
  await page.goto("/customer");
  await expect(page).toHaveURL(/\/change-password$/);

  // The rules are shown and checked as the user types.
  const rules = page.getByRole("list", { name: "Password rules" });
  await expect(rules).toContainText("At least 10 characters");
  const save = page.getByRole("button", { name: "Save new password" });
  await page.getByLabel("New password", { exact: true }).fill("short1");
  await expect(save).toBeDisabled();
  await page.getByLabel("New password", { exact: true }).fill("bandara-2026-new");
  await page.getByLabel("Type the new password again").fill("bandara-2026-new");
  await expect(save).toBeDisabled(); // contains the username

  const newPassword = "Kandy-Lake-2026-e2e";
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Type the new password again").fill(newPassword);
  await save.click();

  await expect(page).toHaveURL(/\/customer$/);
  await expect(page.getByRole("heading", { name: "What you need to do now" })).toBeVisible();
});

test("owner.ceylon completes company setup before reaching the dashboard (BRD-01)", async ({ page }) => {
  await signInAndWait(page, DEMO.ownerCeylon.username, DEMO.ownerCeylon.password, /\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up your company" })).toBeVisible();

  // The dashboard and other owner pages are not reachable yet.
  await page.goto("/owner");
  await expect(page).toHaveURL(/\/setup$/);
  await page.goto("/owner/customers");
  await expect(page).toHaveURL(/\/setup$/);

  // Company details are pre-filled from the owner account; bank details are not.
  await expect(page.getByLabel("Company name")).toHaveValue("Ceylon Office Machines");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText("Bank name is required.")).toBeVisible();

  await page.getByLabel("Bank", { exact: true }).fill("Commercial Bank");
  await page.getByLabel("Account number").fill("8001234567");
  // Optional logo: a tiny PNG, converted and stored privately.
  await page.getByTestId("logo-input").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole("heading", { name: /^Hello/ })).toBeVisible();
  await expect(page.getByRole("img", { name: "Ceylon Office Machines logo" })).toBeVisible();

  // Setup is done once: /setup now leads to the dashboard.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/owner$/);

  // BRD-03: details and logo can be changed later in Settings.
  await page.goto("/owner/settings/company");
  await expect(page.getByLabel("Account number")).toHaveValue("8001234567");
  await page.getByLabel("Phone").fill("081 999 0000");
  await page.getByRole("button", { name: "Remove logo" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Phone")).toHaveValue("081 999 0000");
  await expect(page.getByRole("img", { name: "Ceylon Office Machines logo" })).toHaveCount(0);
});
