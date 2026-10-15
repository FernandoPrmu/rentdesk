import { A4_LANDSCAPE, type Block, COLOR, type Company, type Fonts, label, type PageSize, para, type PdfAssets, type PdfFonts, renderFramedPdf, type RenderResult, tableRow } from "../../invoices/pdf/kit.ts";
import { A4 } from "../../invoices/pdf/layout.ts";
import { type ColumnType, formatCell, type ReportDocument, type ReportSection } from "../document.ts";

/**
 * RPT-07: a report as an A4 PDF on the same engine and branding as invoices
 * (pdf-lib, Noto Sans, the owner's built-in company header; decision 83). English
 * only (decision 33). Wide tables go on A4 landscape. Only relative imports.
 */

const WEIGHT: Record<ColumnType, number> = { text: 2.4, money: 1.35, count: 1, decimal: 0.9, percent: 0.9, date: 1.25, month: 1.1 };

export function columnFractions(section: Pick<ReportSection, "columns">): number[] {
  const weights = section.columns.map((c) => WEIGHT[c.type]);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

/** Tables wider than seven columns get A4 landscape, so labels and serials are not broken. */
export function pageFor(doc: Pick<ReportDocument, "sections">): PageSize {
  return Math.max(0, ...doc.sections.map((s) => s.columns.length)) > 7 ? A4_LANDSCAPE : A4;
}

/** Font size for a table: smaller as it gets wider (landscape pages have room for more). */
export function tableFontSize(columns: number, landscape = false): number {
  if (landscape) return columns <= 9 ? 9 : 8;
  return columns <= 5 ? 9 : columns <= 8 ? 8 : 7;
}

/** Page margins of the built-in template (kit.ts), for the table width. */
const MARGIN = 40;
const CELL_PAD = 4;

/** The header font size at which every column label's longest word fits its column, so no label is split mid-word. */
export function headerFontSize(
  section: Pick<ReportSection, "columns">,
  bold: { widthOfTextAtSize(text: string, size: number): number },
  tableWidth: number,
  size: number,
): number {
  const fractions = columnFractions(section);
  let fit = size;
  section.columns.forEach((c, i) => {
    const room = tableWidth * fractions[i] - CELL_PAD * 2;
    const longest = Math.max(0, ...c.label.split(/\s+/).map((w) => bold.widthOfTextAtSize(w, 1)));
    if (longest > 0) fit = Math.min(fit, room / longest);
  });
  return Math.max(6, Math.floor(fit * 4) / 4);
}

function sectionBlocks(section: ReportSection, f: Fonts, landscape: boolean, tableWidth: number): Block[] {
  const fractions = columnFractions(section);
  const size = tableFontSize(section.columns.length, landscape);
  const align = (type: ColumnType) => (type === "text" ? "left" : "right") as "left" | "right";
  const blocks: Block[] = [label(section.title, f)];
  const headerSize = headerFontSize(section, f.bold, tableWidth, size);
  blocks.push(tableRow(section.columns.map((c) => ({ text: c.label, align: align(c.type) })), fractions, f, { size: headerSize, header: true, fill: COLOR.fill }));
  for (const row of section.rows) {
    blocks.push(tableRow(section.columns.map((c) => ({ text: formatCell(c.type, row[c.key] ?? null), align: align(c.type) })), fractions, f, { size }));
  }
  if (section.rows.length === 0) blocks.push(para(section.empty ?? "Nothing to show.", { font: f.regular, size: 9, color: COLOR.muted }));
  if (section.totals && section.rows.length > 0) {
    const totals = section.totals;
    blocks.push(
      tableRow(
        section.columns.map((c) => ({ text: totals[c.key] === undefined ? "" : formatCell(c.type, totals[c.key]), align: align(c.type), bold: true })),
        fractions,
        f,
        { size, fill: COLOR.total },
      ),
    );
  }
  return blocks;
}

export interface ReportPdfOptions {
  company: Company;
  assets: PdfAssets;
  fonts: PdfFonts;
  /** "12 Oct 2026, 14:05" (Colombo). */
  generatedLabel: string;
  warn?: (message: string) => void;
}

export function renderReportPdf(doc: ReportDocument, options: ReportPdfOptions): Promise<RenderResult> {
  const pageSize = pageFor(doc);
  const landscape = pageSize.width > pageSize.height;
  return renderFramedPdf({
    pageSize,
    title: `${doc.title} (${doc.period})`,
    author: doc.company,
    name: doc.report,
    letterhead: null,
    company: options.company,
    assets: { logo: options.assets.logo, letterhead: null },
    fonts: options.fonts,
    stamps: [],
    footer: `${doc.title} · ${doc.period} · made ${options.generatedLabel} · RentDesk`,
    warn: options.warn ?? (() => {}),
    blocks: (f) => [
      para(doc.title, { font: f.bold, size: 16 }),
      para(doc.period, { font: f.regular, size: 9.5, color: COLOR.muted }),
      ...(doc.summary.length
        ? [
            tableRow(
              doc.summary.map((s) => ({ text: s.label })),
              doc.summary.map(() => 1 / doc.summary.length),
              f,
              { size: 8, header: true, rule: false },
            ),
            tableRow(
              doc.summary.map((s) => ({ text: formatCell(s.type, s.value, "screen"), bold: true })),
              doc.summary.map(() => 1 / doc.summary.length),
              f,
              { size: 10.5 },
            ),
          ]
        : []),
      ...doc.sections.flatMap((s) => sectionBlocks(s, f, landscape, pageSize.width - MARGIN * 2)),
      ...(doc.notes ?? []).map((n) => para(n, { font: f.regular, size: 7.5, color: COLOR.muted })),
    ],
  });
}
