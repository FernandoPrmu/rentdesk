import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Signs in and waits until the browser has left the login page. */
export async function signInAndWait(page: Page, username: string, password: string, expectedPath: RegExp) {
  await signIn(page, username, password);
  await expect(page).toHaveURL(expectedPath);
}
