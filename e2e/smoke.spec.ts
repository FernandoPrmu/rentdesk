import { expect, test } from "@playwright/test";

test("landing page links to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "RentDesk" })).toBeVisible();

  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Username")).toBeVisible();
});

test("serves the web app manifest", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBe("RentDesk");
  expect(manifest.display).toBe("standalone");
});
