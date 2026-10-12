import writeXlsxFile, { type Cell, type Row, type Sheet } from "write-excel-file/node";

import type { CellValue, ColumnType, ReportDocument, ReportSection } from "../document.ts";

/**
 * RPT-07: a report as an Excel workbook (decision 83), server-side with
 * write-excel-file: one sheet per section. Money cells are numbers in rupees with
 * the format #,##0.00 (integer cents divided once, here at the edge); dates are real
 * dates shown as yyyy-mm-dd; months are dates shown as mmm yyyy; text that a
 * spreadsheet could take for a formula (=, +, -, @, tab, CR) gets a leading
 * apostrophe so it stays text.
 */

export const MONEY_FORMAT = "#,##0.00";
export const DATE_FORMAT = "yyyy-mm-dd";
export const MONTH_FORMAT = "mmm yyyy";
const COUNT_FORMAT = "#,##0";
const DECIMAL_FORMAT = "0.0";
const PERCENT_FORMAT = "0.0%";

/** Formula injection (OWASP "CSV injection"): keep such text as text. */
export function safeText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** An ISO calendar date as a Date at UTC midnight (the date Excel shows). */
export function excelDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

export function excelCell(type: ColumnType, value: CellValue): Cell {
  if (value === null || value === "") return null;
  // A label in a date or number column (the "Total" row) is text.
  if ((type === "date" || type === "month") && !ISO_DATE.test(String(value))) return { value: safeText(String(value)), type: String };
  if (type !== "text" && type !== "date" && type !== "month" && typeof value === "string" && Number.isNaN(Number(value))) {
    return { value: safeText(value), type: String };
  }
  switch (type) {
    case "money":
      return { value: Number(value) / 100, type: Number, format: MONEY_FORMAT };
    case "count":
      return { value: Number(value), type: Number, format: COUNT_FORMAT };
    case "decimal":
      return { value: Number(value), type: Number, format: DECIMAL_FORMAT };
    case "percent":
      return { value: Number(value) / 100, type: Number, format: PERCENT_FORMAT };
    case "date":
      return { value: excelDate(String(value)), type: Date, format: DATE_FORMAT };
    case "month":
      return { value: excelDate(String(value)), type: Date, format: MONTH_FORMAT };
    default:
      return { value: safeText(String(value)), type: String };
  }
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ], unique. */
export function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 28) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Rows of one sheet: report title, company and period, a blank row, then the header
 * row (bold), the data rows and the totals row (bold).
 */
export function sectionRows(doc: ReportDocument, section: ReportSection): Row[] {
  const title: Row = [{ value: safeText(`${doc.title}: ${section.title}`), type: String, fontWeight: "bold" }];
  const meta: Row = [{ value: safeText(`${doc.company} · ${doc.period}`), type: String }];
  const header: Row = section.columns.map((c) => ({ value: safeText(c.label || " "), type: String, fontWeight: "bold" as const }));
  const rows: Row[] = section.rows.map((r) => section.columns.map((c) => excelCell(c.type, r[c.key] ?? null)));
  const out: Row[] = [title, meta, [null], header, ...rows];
  if (section.totals) {
    out.push(
      section.columns.map((c) => {
        const cell = excelCell(c.type, section.totals![c.key] ?? null);
        return cell && typeof cell === "object" && !(cell instanceof Date) ? { ...cell, fontWeight: "bold" as const } : cell;
      }),
    );
  }
  if (section.rows.length === 0 && section.empty) out.push([{ value: safeText(section.empty), type: String }]);
  return out;
}

const WIDTH: Record<ColumnType, number> = { text: 30, money: 15, count: 11, decimal: 10, percent: 10, date: 12, month: 11 };

export async function reportXlsx(doc: ReportDocument): Promise<Buffer> {
  const used = new Set<string>();
  const sheets: Sheet<Buffer>[] = doc.sections.map((section) => ({
    data: sectionRows(doc, section),
    sheet: sheetName(section.title, used),
    columns: section.columns.map((c) => ({ width: WIDTH[c.type] })),
  }));
  if (doc.notes?.length) {
    sheets.push({
      data: [[{ value: "Notes", type: String, fontWeight: "bold" }], ...doc.notes.map((n): Row => [{ value: safeText(n), type: String }])],
      sheet: sheetName("Notes", used),
      columns: [{ width: 120 }],
    });
  }
  return writeXlsxFile(sheets).toBuffer();
}
