import { expect, type Page } from "@playwright/test";

/**
 * Waits for a Home dashboard (owner, customer summary, admin). Home streams it with a
 * 4 s limit and shows "Try again" when the database is slow (decision 84); the query
 * keeps running and fills the cache, so tapping Try again is what a user does next.
 * The test does the same, up to the step timeout, instead of failing on that screen.
 */
export async function waitForDashboard(page: Page, testId: string) {
  const dashboard = page.getByTestId(testId).filter({ visible: true });
  const retry = page.getByTestId("summary-unavailable").filter({ visible: true }).getByRole("link", { name: "Try again" });
  await expect
    .poll(
      async () => {
        if (await dashboard.count()) return "shown";
        if (await retry.count()) await retry.first().click();
        return "waiting";
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 4_000] },
    )
    .toBe("shown");
}
