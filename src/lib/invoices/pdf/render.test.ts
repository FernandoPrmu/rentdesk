import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { brandingFromSnapshot, documentHash, type InvoiceDocument, sampleInvoiceDocument } from "./document";
import { loadInvoiceFonts } from "./fonts";
import { presetLayout } from "./layout";
import { type InvoiceFonts, renderInvoicePdf } from "./render";

/**
 * PDF content (INV-09, BRD-04..06, decision 33): real PDFs are rendered and their
 * text extracted with pdf.js, for the built-in template, an image letterhead, a
 * PDF letterhead, and old data with Sinhala/Tamil names (replaced, not broken).
 */

let fonts: InvoiceFonts;
beforeAll(async () => {
  fonts = await loadInvoiceFonts();
});

async function pdfText(bytes: Uint8Array): Promise<{ pages: string[]; all: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " "));
  }
  await task.destroy();
  return { pages, all: pages.join(" \n ") };
}

const SNAPSHOT = {
  company_name: "Lanka Copiers (Pvt) Ltd",
  address: "No. 45, Galle Road\nColombo 03",
  phone: "011 234 5678",
  email: "accounts@lankacopiers.lk",
  bank_name: "Commercial Bank",
  bank_branch: "Kollupitiya",
  bank_account_name: "Lanka Copiers (Pvt) Ltd",
  bank_account_no: "1000 2345 67",
  payment_instructions: "Cheques payable to Lanka Copiers (Pvt) Ltd.",
};

function invoice(overrides: Partial<InvoiceDocument> = {}, snapshot: Record<string, unknown> = SNAPSHOT): InvoiceDocument {
  return { ...sampleInvoiceDocument(brandingFromSnapshot(snapshot), "2026-10-10"), invoiceNo: "INV-000042", dueDate: "2026-10-17", ...overrides };
}

/** The essentials every invoice PDF must show (spec 6.6). */
function expectInvoiceContent(text: string) {
  expect(text).toContain("INV-000042");
  expect(text).toContain("Monthly commitment");
  expect(text).toContain("B&W copies above 3,000 included");
  expect(text).toContain("Colour copies above 500 included");
  expect(text).toContain("Rs. 10,000.00");
  expect(text).toContain("Rs. 800.00");
  expect(text).toContain("Rs. 2,000.00");
  expect(text).toContain("Rs. 12,800.00"); // total
  expect(text).toContain("17 Oct 2026"); // due date
  expect(text).toContain("Sample Customer");
  expect(text).toContain("SAMPLE-123");
  expect(text).toContain("Commercial Bank, Kollupitiya");
  expect(text).toContain("13,400"); // current B&W reading
}

async function a4Png(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="877"><rect width="620" height="877" fill="#fff"/><rect width="620" height="130" fill="#0f4c81"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

async function a4Pdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 700, width: 595.28, height: 141.89, color: rgb(0.55, 0.1, 0.1) });
  page.drawText("CEYLON OFFICE SYSTEMS", { x: 40, y: 760, size: 24, font: await pdf.embedFont(StandardFonts.HelveticaBold), color: rgb(1, 1, 1) });
  return pdf.save();
}

describe("invoice PDF", () => {
  it("built-in template (BRD-06): company block, data, lines, total, due date, bank details", async () => {
    const r = await renderInvoicePdf(invoice(), { logo: null, letterhead: null }, fonts, { version: 1 });
    expect(r.template).toBe("BUILT_IN");
    expect(r.pages).toBe(1);
    expect(new TextDecoder().decode(r.bytes.slice(0, 5))).toBe("%PDF-");
    const { all } = await pdfText(r.bytes);
    expectInvoiceContent(all);
    expect(all).toContain("Lanka Copiers (Pvt) Ltd");
    expect(all).toContain("No. 45, Galle Road");
    expect(all).toContain("Cheques payable to Lanka Copiers (Pvt) Ltd.");
    expect(all).toContain("Version 1");
    expect(r.bytes.length).toBeLessThan(150_000); // fonts are subset
  });

  it("image letterhead (BRD-04/05): the data goes in the letterhead's data area", async () => {
    const doc = invoice({ letterhead: { path: "o/letterheads/x.png", kind: "IMAGE", layout: presetLayout("HEADER_FOOTER") } });
    const r = await renderInvoicePdf(doc, { logo: null, letterhead: await a4Png() }, fonts, { version: 2 });
    expect(r.template).toBe("LETTERHEAD");
    expect(r.pages).toBe(1);
    const { all } = await pdfText(r.bytes);
    expectInvoiceContent(all);
    expect(all).toContain("Version 2");
  });

  it("PDF letterhead (BRD-04): page 1 is embedded as the background", async () => {
    const doc = invoice({ letterhead: { path: "o/letterheads/x.pdf", kind: "PDF", layout: presetLayout("FULL_PAGE") } });
    const r = await renderInvoicePdf(doc, { logo: null, letterhead: await a4Pdf() }, fonts, { version: 1 });
    expect(r.template).toBe("LETTERHEAD");
    const { all } = await pdfText(r.bytes);
    expect(all).toContain("CEYLON OFFICE SYSTEMS"); // from the letterhead itself
    expectInvoiceContent(all);
  });

  it("a letterhead that cannot be read falls back to the built-in template with a warning", async () => {
    const warn = vi.fn();
    const doc = invoice({ letterhead: { path: "o/letterheads/x.pdf", kind: "PDF", layout: presetLayout("HEADER_ONLY") } });
    const r = await renderInvoicePdf(doc, { logo: null, letterhead: new TextEncoder().encode("not a pdf") }, fonts, { version: 1, warn });
    expect(r.template).toBe("BUILT_IN");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/letterhead could not be used/));
    expectInvoiceContent((await pdfText(r.bytes)).all);
  });

  it("old data with Sinhala or Tamil names: unsupported characters become ? with a warning, never broken output (decision 33)", async () => {
    const warn = vi.fn();
    const doc = invoice(
      { parties: { ...invoice().parties, customer: { name: "கொழும்பு அச்சகம்", businessName: null, address: "Kandy" } } },
      { ...SNAPSHOT, company_name: "ශ්‍රී ලංකා Copiers" },
    );
    const r = await renderInvoicePdf(doc, { logo: null, letterhead: null }, fonts, { version: 1, warn });
    const { all } = await pdfText(r.bytes);
    expect(all).toMatch(/\?+ \?+ Copiers/);
    expect(all).not.toMatch(/[඀-෿஀-௿]/);
    expect(all).toContain("Rs. 12,800.00");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("company.name"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parties.customer.name"));
  });

  it("labels: estimated, final invoice, cancelled", async () => {
    const estimated = await pdfText((await renderInvoicePdf(invoice({ kind: "ESTIMATED", counters: [] }), { logo: null, letterhead: null }, fonts, { version: 1 })).bytes);
    expect(estimated.all).toContain("ESTIMATED");
    expect(estimated.all).toContain("no meter reading was received");

    const final = await pdfText(
      (await renderInvoicePdf(invoice({ kind: "FINAL", partial: { daysUsed: 12, daysInCycle: 31, rule: "PRORATED" } }), { logo: null, letterhead: null }, fonts, { version: 1 })).bytes,
    );
    expect(final.all).toContain("FINAL INVOICE");
    expect(final.all).toContain("12 of 31 days");

    const cancelled = await pdfText(
      (await renderInvoicePdf(invoice({ cancelled: { date: "2026-10-12", reason: "Wrong rate" } }), { logo: null, letterhead: null }, fonts, { version: 3 })).bytes,
    );
    expect(cancelled.all).toContain("CANCELLED");
    expect(cancelled.all).toContain("cancelled on 12 Oct 2026: Wrong rate. Do not pay it.");
  });

  it("a long invoice in a small data area shrinks, then continues on a second page with the letterhead", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ type: "ADJUSTMENT" as const, description: `Adjustment ${i + 1}`, quantity: 1, rateCents: 0, amountCents: 100 }));
    const doc = invoice({ lines, totalCents: 4_000, letterhead: { path: "o/letterheads/x.png", kind: "IMAGE", layout: presetLayout("FULL_PAGE") } });
    const r = await renderInvoicePdf(doc, { logo: null, letterhead: await a4Png() }, fonts, { version: 1 });
    expect(r.pages).toBeGreaterThan(1);
    const { pages } = await pdfText(r.bytes);
    const last = pages.at(-1) ?? "";
    expect(pages[0]).toContain("INV-000042");
    expect(pages[0]).toContain("Adjustment 1 ");
    expect(pages.join(" ")).toContain("Adjustment 40");
    expect(pages.join(" ")).toContain("Rs. 40.00"); // total
    expect(last).toContain("HOW TO PAY");
    expect(last).toContain(`Page ${r.pages} of ${r.pages}`);
    // Every line is printed exactly once.
    for (let i = 1; i <= 40; i++) expect(pages.join(" ").split(`Adjustment ${i} `).length - 1, `line ${i}`).toBe(1);
  });

  it("the content hash ignores nothing printed and changes with the amounts", () => {
    expect(documentHash(invoice())).toBe(documentHash(invoice()));
    expect(documentHash(invoice({ totalCents: 1_330_000 }))).not.toBe(documentHash(invoice()));
    expect(documentHash(invoice({ dueDate: "2026-10-20" }))).not.toBe(documentHash(invoice()));
  });
});
