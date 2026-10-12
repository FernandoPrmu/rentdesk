import { formatDate } from "../format.ts";
import { formatRupees } from "../money.ts";
import { monthLabel } from "./period.ts";

/**
 * One shape for every report (RPT-07): the screen tables, the PDF and the Excel
 * file are all made from a ReportDocument, so they always show the same figures.
 * Money cells hold integer cents; dates ISO calendar dates. Pure.
 */

export type ColumnType = "text" | "money" | "count" | "date" | "month" | "percent" | "decimal";
export type CellValue = string | number | null;
export type ReportRow = Record<string, CellValue>;

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportSection {
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  /** Shown when there are no rows. */
  empty?: string;
}

export interface SummaryItem {
  label: string;
  value: CellValue;
  type: ColumnType;
}

export interface ReportDocument {
  report: string;
  title: string;
  /** "1 Aug 2026 – 12 Oct 2026" or "As of 12 Oct 2026". */
  period: string;
  /** Company (owner) or "RentDesk" (admin reports). */
  company: string;
  /** ISO timestamp. */
  generatedAt: string;
  summary: SummaryItem[];
  sections: ReportSection[];
  /** Short explanation of the figures (definitions). */
  notes?: string[];
}

/** Most rows an export carries per section (the free tier's function time). */
export const MAX_EXPORT_ROWS = 5000;

const decimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const count = new Intl.NumberFormat("en-US");

/** Cents -> "12,800.00" (tables: the column says rupees). */
export function formatMoneyCell(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = count.format(Math.trunc(abs / 100));
  return `${negative ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** A cell as text. `style` "screen" shows money as "Rs. 12,800". */
export function formatCell(type: ColumnType, value: CellValue, style: "screen" | "table" = "table"): string {
  if (value === null || value === "") return "—";
  // A label in a typed column (the "Total" row) is shown as it is.
  if (typeof value === "string" && type !== "text" && !(type === "date" || type === "month" ? /^\d{4}-\d{2}-\d{2}/.test(value) : Number.isFinite(Number(value)))) {
    return value;
  }
  switch (type) {
    case "money":
      return style === "screen" ? formatRupees(Number(value)) : formatMoneyCell(Number(value));
    case "count":
      return count.format(Number(value));
    case "decimal":
      return decimal.format(Number(value));
    case "percent":
      return `${decimal.format(Number(value))}%`;
    case "date":
      return formatDate(String(value));
    case "month":
      return monthLabel(String(value));
    default:
      return String(value);
  }
}
