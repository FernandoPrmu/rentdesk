import { strFromU8, unzipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";
import { beforeAll, describe, expect, it } from "vitest";

import { loadInvoiceFonts } from "../../invoices/pdf/fonts";
import type { PdfFonts } from "../../invoices/pdf/kit";
import { buildIncome, buildMachines } from "../build";
import type { ReportDocument } from "../document";
import { formatCell, formatMoneyCell } from "../document";
import { presetRange } from "../period";
import { columnFractions, renderReportPdf, tableFontSize } from "./pdf";
import { DATE_FORMAT, excelCell, MONEY_FORMAT, reportXlsx, safeText, sheetName } from "./xlsx";

/**
 * RPT-07 exports: Excel cell types (money numeric #,##0.00, dates as real dates
 * yyyy-mm-dd, no formulas), files read back with read-excel-file, and the PDF text.
 */

const ctx = { range: presetRange("last_3_months", "2026-10-12"), today: "2026-10-12", company: "Lanka Copiers", generatedAt: "2026-10-12T08:00:00Z" };

const sample: ReportDocument = {
  report: "test",
  title: "Test report",
  period: "1 Aug 2026 – 12 Oct 2026",
  company: "Lanka Copiers",
  generatedAt: "2026-10-12T08:00:00Z",
  summary: [{ label: "Total", value: 1_280_050, type: "money" }],
  sections: [
    {
      title: "Bills",
      columns: [
        { key: "name", label: "Customer", type: "text" },
        { key: "due", label: "Due date", type: "date" },
        { key: "amount", label: "Amount", type: "money" },
        { key: "copies", label: "Copies", type: "count" },
        { key: "pct", label: "On time", type: "percent" },
      ],
      rows: [
        { name: "Perera Traders", due: "2026-10-18", amount: 1_280_050, copies: 3400, pct: 75 },
        { name: "=HYPERLINK(\"http://evil\",\"x\")", due: "2026-02-28", amount: -50_000, copies: 0, pct: null },
        { name: "+94 77 123 4567", due: null, amount: 5, copies: 1, pct: 100 },
      ],
      totals: { name: "Total", amount: 1_230_055, copies: 3401 },
    },
  ],
  notes: ["@SUM(A1) is just a note"],
};

/** Excel's built-in number formats that write-excel-file may use. */
const BUILT_IN: Record<number, string> = { 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 14: "m/d/yyyy" };

/** The number format of each cell of sheet `n` (1-based), by cell reference. */
function cellFormats(xlsx: Uint8Array, n: number): Map<string, { format: string | null; type: string | null; formula: boolean }> {
  const files = unzipSync(xlsx);
  const styles = strFromU8(files["xl/styles.xml"]);
  const sheet = strFromU8(files[`xl/worksheets/sheet${n}.xml`]);
  const numFmts = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) numFmts.set(Number(m[1]), m[2].replaceAll("&quot;", '"'));
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const xfs = [...cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0));
  const out = new Map<string, { format: string | null; type: string | null; formula: boolean }>();
  for (const m of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const s = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const id = xfs[s] ?? 0;
    out.set(ref, { format: numFmts.get(id) ?? BUILT_IN[id] ?? null, type: /\bt="(\w+)"/.exec(attrs)?.[1] ?? null, formula: /<f[\s>]/.test(m[2] ?? "") });
  }
  return out;
}

describe("xlsx export (RPT-07, decision 83)", () => {
  let file: Buffer;
  beforeAll(async () => {
    file = await reportXlsx(sample);
  });

  it("is a real xlsx (zip) that read-excel-file opens, one sheet per section plus notes", async () => {
    expect([...file.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    const sheets = await readXlsxFile(file);
    expect(sheets.map((s) => s.sheet)).toEqual(["Bills", "Notes"]);
    const data = sheets[0].data;
    expect(data[0][0]).toBe("Test report: Bills");
    expect(data[1][0]).toBe("Lanka Copiers · 1 Aug 2026 – 12 Oct 2026");
    expect(data[3]).toEqual(["Customer", "Due date", "Amount", "Copies", "On time"]);
  });

  it("money cells are numbers in rupees; dates come back as dates", async () => {
    const [{ data }] = await readXlsxFile(file);
    const [first, second, third, totals] = data.slice(4);
    expect(first[2]).toBe(12800.5);
    expect(typeof first[2]).toBe("number");
    expect(second[2]).toBe(-500);
    expect(third[2]).toBe(0.05);
    expect(first[1]).toBeInstanceOf(Date);
    expect((first[1] as unknown as Date).toISOString().slice(0, 10)).toBe("2026-10-18");
    expect((second[1] as unknown as Date).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(third[1]).toBeNull();
    expect(first[4]).toBeCloseTo(0.75);
    expect(totals[0]).toBe("Total");
    expect(totals[2]).toBe(12300.55);
  });

  it("money cells carry #,##0.00, date cells yyyy-mm-dd, counts #,##0", () => {
    const cells = cellFormats(file, 1);
    // Row 5 is the first data row (title, meta, blank, header).
    expect(cells.get("C5")?.format).toBe(MONEY_FORMAT);
    expect(cells.get("C8")?.format).toBe(MONEY_FORMAT);
    expect(cells.get("B5")?.format).toBe(DATE_FORMAT);
    expect(cells.get("D5")?.format).toBe("#,##0");
    expect(cells.get("C5")?.type).not.toBe("s");
  });

  it("text that looks like a formula stays text: no formula anywhere", async () => {
    const cells = cellFormats(file, 1);
    expect([...cells.values()].some((c) => c.formula)).toBe(false);
    expect([...cellFormats(file, 2).values()].some((c) => c.formula)).toBe(false);
    const [bills, notes] = await readXlsxFile(file);
    expect(bills.data[5][0]).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    expect(bills.data[6][0]).toBe("'+94 77 123 4567");
    expect(notes.data[1][0]).toBe("'@SUM(A1) is just a note");
  });

  it("cell helpers", () => {
    expect(safeText("-5")).toBe("'-5");
    expect(safeText("\tcmd")).toBe("'\tcmd");
    expect(safeText("Perera")).toBe("Perera");
    expect(excelCell("money", 1999)).toMatchObject({ value: 19.99, format: MONEY_FORMAT });
    expect(excelCell("text", null)).toBeNull();
    const used = new Set<string>();
    expect(sheetName("By month: income [x]", used)).toBe("By month  income  x");
    expect(sheetName("A very long section title that goes on", used).length).toBeLessThanOrEqual(31);
    expect(sheetName("By month  income  x", used)).toBe("By month  income  x 2");
  });

  it("a real report document exports", async () => {
    const doc = buildIncome(
      [
        { month: "2026-09-01", commitment_cents: 1_000_000, excess_cents: 280_000, other_cents: 0, discount_cents: 0, invoices: 1, payments_cents: 1_280_000, advances_cents: 0, deposits_kept_cents: 0, refunds_cents: 0 },
      ],
      ctx,
    );
    const [sheet] = await readXlsxFile(await reportXlsx(doc));
    expect(sheet.data[4][0]).toBeInstanceOf(Date);
    expect(sheet.data[4][5]).toBe(12800);
    expect(sheet.data.at(-1)?.[0]).toBe("Total");
  });
});

describe("report PDF (RPT-07)", () => {
  let fonts: PdfFonts;
  beforeAll(async () => {
    fonts = await loadInvoiceFonts();
  });

  async function pdfText(bytes: Uint8Array): Promise<string> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    const d = await task.promise;
    const parts: string[] = [];
    for (let i = 1; i <= d.numPages; i++) {
      const content = await (await d.getPage(i)).getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    await task.destroy();
    return parts.join(" ").replace(/\s+/g, " ");
  }

  it("has the company header, title, period, figures and totals", async () => {
    const doc = buildMachines(
      [
        {
          id: "m1", brand: "Canon", model: "iR C3226", serial_no: "C-1", type: "COLOUR", status: "RENTED", customer: "Perera Traders",
          revenue_cents: 1_280_000, commitment_cents: 1_000_000, bw_excess_cents: 80_000, colour_excess_cents: 200_000, other_cents: 0,
          bw_copies: 3400, colour_copies: 700, service_cost_cents: 300_000, toner_cost_cents: 250_000, requests: 2, toner_requests: 1,
        },
      ],
      ctx,
    );
    const result = await renderReportPdf(doc, {
      company: { name: "Lanka Copiers", address: "12 Galle Road", phone: "011 234 5678", email: null },
      assets: { logo: null, letterhead: null },
      fonts,
      generatedLabel: "12 Oct 2026, 13:30",
    });
    expect(String.fromCharCode(...result.bytes.subarray(0, 5))).toBe("%PDF-");
    const text = await pdfText(result.bytes);
    for (const s of ["Lanka Copiers", "Machine performance", "1 Aug 2026 – 12 Oct 2026", "Canon iR C3226 (C-1)", "12,800.00", "3,400", "9,800.00", "76.6%", "Total", "Page 1 of 1"]) {
      expect(text).toContain(s);
    }
  });

  it("many rows flow onto more pages", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ name: `Customer ${i + 1}`, due: "2026-10-01", amount: i * 100, copies: i, pct: 50 }));
    const result = await renderReportPdf({ ...sample, sections: [{ ...sample.sections[0], rows }] }, {
      company: { name: "Lanka Copiers", address: null, phone: null, email: null },
      assets: { logo: null, letterhead: null },
      fonts,
      generatedLabel: "now",
    });
    expect(result.pages).toBeGreaterThan(1);
    expect(await pdfText(result.bytes)).toContain("Customer 120");
  });

  it("column widths and font size", () => {
    const f = columnFractions(sample.sections[0]);
    expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(f[0]).toBeGreaterThan(f[2]);
    expect(tableFontSize(4)).toBe(9);
    expect(tableFontSize(12)).toBe(7);
  });

  it("cell text formats", () => {
    expect(formatMoneyCell(1_280_050)).toBe("12,800.50");
    expect(formatMoneyCell(-5)).toBe("-0.05");
    expect(formatCell("money", 1_280_000, "screen")).toBe("Rs. 12,800");
    expect(formatCell("date", "2026-10-18")).toBe("18 Oct 2026");
    expect(formatCell("month", "2026-10-01")).toBe("Oct 2026");
    expect(formatCell("percent", 76.6)).toBe("76.6%");
    expect(formatCell("count", null)).toBe("—");
    // The totals row's label in a month or money column.
    expect(formatCell("month", "Total")).toBe("Total");
    expect(formatCell("date", "Total", "screen")).toBe("Total");
    expect(formatCell("money", "Total")).toBe("Total");
  });

  it("a report whose totals row labels a month column renders (income)", async () => {
    const doc = buildIncome(
      [{ month: "2026-09-01", commitment_cents: 1, excess_cents: 0, other_cents: 0, discount_cents: 0, invoices: 1, payments_cents: 0, advances_cents: 0, deposits_kept_cents: 0, refunds_cents: 0 }],
      ctx,
    );
    const result = await renderReportPdf(doc, { company: { name: "Lanka Copiers", address: null, phone: null, email: null }, assets: { logo: null, letterhead: null }, fonts, generatedLabel: "now" });
    const text = await pdfText(result.bytes);
    expect(text).toContain("Sep 2026");
    expect(text).toContain("Total");
  });
});
