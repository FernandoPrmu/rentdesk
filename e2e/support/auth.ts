import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/**
 * Session cookies of the demo accounts, shared by the specs of one run. Feature specs
 * that do not test signing in reuse them, so the suite stays under Supabase Auth's
 * sign-in rate limit (429 over_request_rate_limit). Cleared by the global setup.
 */
export const SESSION_DIR = path.join(process.cwd(), "playwright", ".auth");

export function clearSessions() {
  rmSync(SESSION_DIR, { recursive: true, force: true });
}

/**
 * Opens `home` as the account: with its saved session when there is one that still
 * works, otherwise by signing in (and saving the session for the next test).
 */
export async function signInCached(page: Page, account: { username: string; password: string }, home: string) {
  const file = path.join(SESSION_DIR, `${account.username}.json`);
  const homeUrl = new RegExp(`${home}$`);
  await page.context().clearCookies();
  if (existsSync(file)) {
    await page.context().addCookies(JSON.parse(readFileSync(file, "utf8")));
    await page.goto(home);
    if (new URL(page.url()).pathname === home) return;
    await page.context().clearCookies();
  }
  await signInAndWait(page, account.username, account.password, homeUrl);
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(await page.context().cookies()));
}
