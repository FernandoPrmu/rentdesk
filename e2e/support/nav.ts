import type { Page } from "@playwright/test";

/**
 * Opens an owner or admin section that lives under "More" on a phone (task 11: the
 * bottom bar keeps Home, Tickets, Service, Customers / Dashboard, Owners, Escalations).
 * A client-side navigation, like tapping the old bottom-bar link.
 */
export async function openFromMore(page: Page, name: string) {
  await page.getByTestId("nav-more").click();
  await page.getByRole("navigation", { name: "More" }).getByRole("link", { name, exact: true }).click();
}
