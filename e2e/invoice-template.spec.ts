import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import sharp from "sharp";

import { signInCached } from "./support/auth";
import { DEMO, profileId, restoreInvoiceTemplate } from "./support/demo";
import { pdfText } from "./support/pdf";

// Settings › Invoice template at 360 px (BRD-04..07): the owner uploads a letterhead,
// picks a preset, drags the data area, previews a sample invoice and saves; then
// removes the letterhead and the sample falls back to the built-in template (BRD-06).
// The template is put back and the uploaded files are removed afterwards
// (restoreInvoiceTemplate, also run by the global setup and teardown).
test.describe.configure({ mode: "serial" });

const dir = path.join(process.cwd(), "test-results", "e2e-files");
const A4_PNG = path.join(dir, "letterhead-a4.png");
const SQUARE_PNG = path.join(dir, "letterhead-square.png");
let ownerId = "";

test.beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  const banner = (w: number, h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/><rect width="${w}" height="${Math.round(h / 7)}" fill="#0f4c81"/></svg>`;
  writeFileSync(A4_PNG, await sharp(Buffer.from(banner(1240, 1754))).png().toBuffer());
  writeFileSync(SQUARE_PNG, await sharp(Buffer.from(banner(900, 900))).png().toBuffer());
  ownerId = await profileId(DEMO.ownerLanka.username);
});

test.afterAll(async () => {
  await restoreInvoiceTemplate();
});

async function letterheadInDb(): Promise<{ letterhead_path: string | null; letterhead_layout: { preset?: string } }> {
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const { rows } = await db.query("select letterhead_path, letterhead_layout from public.owner_company_profiles where owner_id = $1", [ownerId]);
    return rows[0];
  } finally {
    await db.end();
  }
}

/** "Preview sample invoice" opens a new tab; returns the sample PDF's text. */
async function previewText(page: Page): Promise<string> {
  const [tab] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Preview sample invoice" }).click()]);
  const link = page.getByTestId("sample-link");
  await expect(link).toBeVisible({ timeout: 30_000 });
  await tab.close();
  const response = await page.request.get((await link.getAttribute("href")) ?? "");
  expect(response.ok()).toBe(true);
  return pdfText(await response.body());
}

async function openTemplate(page: Page) {
  await signInCached(page, DEMO.ownerLanka, "/owner");
  await page.goto("/owner/settings");
  await page.getByRole("link", { name: "Invoice template and letterhead" }).click();
  await expect(page.getByRole("heading", { name: "Invoice template" })).toBeVisible();
}

test.describe("invoice template and letterhead", () => {
  test("the owner uploads a letterhead, picks a preset, drags the area, previews and saves", async ({ page }) => {
    await openTemplate(page);
    await expect(page.getByText("No letterhead: invoices use the built-in design")).toBeVisible();

    // Not A4: accepted with a warning.
    await page.getByTestId("letterhead-input").setInputFiles(SQUARE_PNG);
    await expect(page.getByTestId("letterhead-warning")).toContainText("not A4");

    // A4: no warning; the layout editor appears with the default preset.
    await page.getByTestId("letterhead-input").setInputFiles(A4_PNG);
    await expect(page.getByTestId("letterhead-warning")).toHaveCount(0);
    await expect(page.getByTestId("layout-editor")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Header only/ })).toHaveAttribute("aria-checked", "true");

    await page.getByRole("radio", { name: /Header and footer/ }).click();
    await expect(page.getByRole("radio", { name: /Header and footer/ })).toHaveAttribute("aria-checked", "true");

    // Drag the data area down a little with a finger-sized move: it becomes a custom position.
    const area = page.getByTestId("layout-area");
    await area.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120)); // the area's middle above the bottom navigation
    const box = (await area.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByText("Your own position.")).toBeVisible();
    const moved = (await area.boundingBox())!;
    expect(moved.y).toBeGreaterThan(box.y + 4);

    // Back to a preset, then preview before saving (BRD-07): the sample uses the letterhead.
    await page.getByRole("radio", { name: /Header and footer/ }).click();
    const sample = await previewText(page);
    expect(sample).toContain("SAMPLE-0001");
    expect(sample).toContain("Rs. 12,800.00");
    expect(sample).not.toContain("12 Galle Road"); // the built-in company block is not drawn on a letterhead
    expect((await letterheadInDb()).letterhead_path).toBeNull(); // nothing saved yet

    // Payment instructions are printed on invoices: English letters only (decision 33).
    await page.getByLabel(/Payment instructions/).fill("චෙක්පත් Lanka Copy Solutions වෙත");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Please use English letters only.")).toBeVisible();
    await page.getByLabel(/Payment instructions/).fill("Cheques payable to Lanka Copy Solutions.");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Invoice template saved")).toBeVisible();
    const saved = await letterheadInDb();
    expect(saved.letterhead_path).toMatch(new RegExp(`^${ownerId}/letterheads/[0-9a-f]{64}\\.png$`));
    expect(saved.letterhead_layout.preset).toBe("HEADER_FOOTER");

    await page.reload();
    await expect(page.getByRole("button", { name: "Replace letterhead" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Header and footer/ })).toHaveAttribute("aria-checked", "true");
  });

  test("removing the letterhead goes back to the built-in template", async ({ page }) => {
    await openTemplate(page);
    await page.getByRole("button", { name: "Remove letterhead" }).click();
    await expect(page.getByText("No letterhead: invoices use the built-in design")).toBeVisible();
    await expect(page.getByTestId("layout-editor")).toHaveCount(0);

    const sample = await previewText(page);
    expect(sample).toContain("12 Galle Road"); // the built-in company block is back
    expect(sample).toContain("Cheques payable to Lanka Copy Solutions.");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Invoice template saved")).toBeVisible();
    expect(await letterheadInDb()).toEqual({ letterhead_path: null, letterhead_layout: {} });
    await page.reload();
    await expect(page.getByRole("button", { name: "Upload letterhead" })).toBeVisible();
  });
});
