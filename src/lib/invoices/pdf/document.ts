import { createHash } from "node:crypto";

import { colomboDate } from "../../tickets/deadlines.ts";
import { toPdfText } from "../../text/english.ts";

import { type LetterheadLayout, parseLayout } from "./layout.ts";

/**
 * What an invoice PDF shows (spec 6.6; INV-09, BRD-03..06), built only from the
 * invoice's stored data and its branding_snapshot, so editing the company
 * details, logo or letterhead later never changes an issued invoice. Customer
 * and machine details are fixed by the first PDF (`parties`). Pure apart from
 * hashing; only relative imports (the seed and DB tests load it outside Next.js).
 */

/** Bump when the drawing changes, so a re-render makes a new version. */
export const RENDERER_VERSION = 1;

export type InvoiceKind = "NORMAL" | "ESTIMATED" | "FINAL";

export interface Parties {
  customer: { name: string; businessName: string | null; address: string | null };
  machine: { brand: string; model: string; serialNo: string; type: "MONO" | "COLOUR"; location: string | null };
}

export interface CounterRow {
  counter: "BW" | "COLOUR";
  previous: number;
  current: number;
  usage: number;
  included: number;
  rolledOver: boolean;
}

export interface LineRow {
  type: "COMMITMENT" | "BW_EXCESS" | "COLOUR_EXCESS" | "LATE_FEE" | "CREDIT" | "ADJUSTMENT";
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
}

export interface LetterheadRef {
  path: string;
  kind: "PDF" | "IMAGE";
  layout: LetterheadLayout;
}

export interface InvoiceDocument {
  invoiceNo: string;
  kind: InvoiceKind;
  cancelled: { date: string | null; reason: string | null } | null;
  issueDate: string;
  dueDate: string | null;
  period: { start: string; end: string };
  cyclesCovered: number;
  cycleNo: number | null;
  partial: { daysUsed: number; daysInCycle: number; rule: string } | null;
  company: { name: string; address: string | null; phone: string | null; email: string | null };
  bank: { name: string; branch: string | null; accountName: string | null; accountNo: string | null } | null;
  paymentInstructions: string | null;
  parties: Parties;
  counters: CounterRow[];
  lines: LineRow[];
  totalCents: number;
  logoPath: string | null;
  letterhead: LetterheadRef | null;
}

/** rpc_claim_invoice_pdf's result (migration 0022). */
export interface InvoicePdfClaim {
  invoice: {
    id: string;
    owner_id: string;
    customer_id: string;
    invoice_no: string;
    type: "NORMAL" | "ESTIMATED";
    status: string;
    period_start: string;
    period_end: string;
    cycles_covered: number;
    total_cents: number;
    due_date: string | null;
    issued_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    calculation: Record<string, unknown> | null;
    branding_snapshot: Record<string, unknown> | null;
    pdf_revision: number;
  };
  lines: { line_type: LineRow["type"]; description: string; quantity: number; rate_cents: number; amount_cents: number }[];
  customer: { name: string; business_name: string | null; address: string | null } | null;
  machine: { brand: string; model: string; serial_no: string; type: "MONO" | "COLOUR" } | null;
  location: string | null;
  cycle_no: number | null;
  latest: { version: number; content_hash: string } | null;
  parties: Parties | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Branding snapshot → letterhead reference (null when none or not a known file type). */
export function letterheadFromSnapshot(snapshot: Record<string, unknown> | null): LetterheadRef | null {
  const path = text(snapshot?.letterhead_path);
  if (!path) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const kind = ext === "pdf" ? "PDF" : ext === "png" || ext === "jpg" || ext === "jpeg" ? "IMAGE" : null;
  return kind ? { path, kind, layout: parseLayout(snapshot?.letterhead_layout) } : null;
}

/** The company block and payment details from a branding snapshot (BRD-03). */
export function brandingFromSnapshot(snapshot: Record<string, unknown> | null) {
  const bankName = text(snapshot?.bank_name);
  return {
    company: {
      name: text(snapshot?.company_name) ?? "",
      address: text(snapshot?.address),
      phone: text(snapshot?.phone),
      email: text(snapshot?.email),
    },
    bank: bankName
      ? {
          name: bankName,
          branch: text(snapshot?.bank_branch),
          accountName: text(snapshot?.bank_account_name),
          accountNo: text(snapshot?.bank_account_no),
        }
      : null,
    paymentInstructions: text(snapshot?.payment_instructions),
    logoPath: text(snapshot?.logo_path),
    letterhead: letterheadFromSnapshot(snapshot),
  };
}

export function partiesFromClaim(claim: InvoicePdfClaim): Parties {
  if (claim.parties) return claim.parties;
  return {
    customer: {
      name: claim.customer?.name ?? "",
      businessName: text(claim.customer?.business_name),
      address: text(claim.customer?.address),
    },
    machine: {
      brand: claim.machine?.brand ?? "",
      model: claim.machine?.model ?? "",
      serialNo: claim.machine?.serial_no ?? "",
      type: claim.machine?.type ?? "MONO",
      location: text(claim.location),
    },
  };
}

export function buildInvoiceDocument(claim: InvoicePdfClaim): InvoiceDocument {
  const inv = claim.invoice;
  const calc = (inv.calculation ?? {}) as {
    counters?: { counter_type: "BW" | "COLOUR"; previous_value: number; current_value: number; usage: number; included: number; rolled_over: boolean }[];
    partial?: { days_used: number; days_in_cycle: number; rule: string } | null;
  };
  const partial = calc.partial ? { daysUsed: num(calc.partial.days_used), daysInCycle: num(calc.partial.days_in_cycle), rule: String(calc.partial.rule) } : null;
  const kind: InvoiceKind = inv.type === "ESTIMATED" ? "ESTIMATED" : partial ? "FINAL" : "NORMAL";
  return {
    invoiceNo: inv.invoice_no,
    kind,
    cancelled: inv.status === "CANCELLED" ? { date: inv.cancelled_at ? colomboDate(new Date(inv.cancelled_at)) : null, reason: text(inv.cancel_reason) } : null,
    issueDate: colomboDate(inv.issued_at ? new Date(inv.issued_at) : new Date()),
    dueDate: inv.due_date,
    period: { start: inv.period_start, end: inv.period_end },
    cyclesCovered: num(inv.cycles_covered) || 1,
    cycleNo: claim.cycle_no ?? null,
    partial,
    ...brandingFromSnapshot(inv.branding_snapshot),
    parties: partiesFromClaim(claim),
    counters: (kind === "ESTIMATED" ? [] : (calc.counters ?? [])).map((c) => ({
      counter: c.counter_type,
      previous: num(c.previous_value),
      current: num(c.current_value),
      usage: num(c.usage),
      included: num(c.included),
      rolledOver: Boolean(c.rolled_over),
    })),
    lines: claim.lines.map((l) => ({
      type: l.line_type,
      description: l.description,
      quantity: num(l.quantity),
      rateCents: num(l.rate_cents),
      amountCents: num(l.amount_cents),
    })),
    totalCents: num(inv.total_cents),
  };
}

/** Same content → same hash: no new version is stored (decision 34). */
export function documentHash(doc: InvoiceDocument): string {
  return createHash("sha256").update(JSON.stringify({ renderer: RENDERER_VERSION, doc })).digest("hex");
}

/**
 * Defence in depth (decision 33): every printed string goes through toPdfText;
 * characters the font cannot draw become "?" and each affected field is reported.
 */
export function sanitizeDocument<T>(doc: T, warn: (message: string) => void): T {
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const { text: clean, replaced } = toPdfText(value);
      if (replaced.length > 0) warn(`${path}: ${replaced.length} unsupported character(s) replaced with "?"`);
      return clean;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k)]));
    }
    return value;
  };
  return walk(doc, "") as T;
}

/** BRD-07: a sample invoice with demo data, using the owner's (unsaved) template. */
export function sampleInvoiceDocument(branding: ReturnType<typeof brandingFromSnapshot>, today: string): InvoiceDocument {
  return {
    invoiceNo: "SAMPLE-0001",
    kind: "NORMAL",
    cancelled: null,
    issueDate: today,
    dueDate: today,
    period: { start: today, end: today },
    cyclesCovered: 1,
    cycleNo: 3,
    partial: null,
    ...branding,
    parties: {
      customer: { name: "Sample Customer", businessName: "Sample Trading (Pvt) Ltd", address: "No. 1, Main Street\nColombo 03" },
      machine: { brand: "Canon", model: "imageRUNNER C3226", serialNo: "SAMPLE-123", type: "COLOUR", location: "Front office" },
    },
    // Spec 6.3, colour case 2: Rs. 10,000 + 400 × 2 + 200 × 10 = Rs. 12,800.
    counters: [
      { counter: "BW", previous: 10_000, current: 13_400, usage: 3_400, included: 3_000, rolledOver: false },
      { counter: "COLOUR", previous: 2_000, current: 2_700, usage: 700, included: 500, rolledOver: false },
    ],
    lines: [
      { type: "COMMITMENT", description: "Monthly commitment", quantity: 1, rateCents: 1_000_000, amountCents: 1_000_000 },
      { type: "BW_EXCESS", description: "B&W copies above 3,000 included", quantity: 400, rateCents: 200, amountCents: 80_000 },
      { type: "COLOUR_EXCESS", description: "Colour copies above 500 included", quantity: 200, rateCents: 1_000, amountCents: 200_000 },
    ],
    totalCents: 1_280_000,
  };
}
