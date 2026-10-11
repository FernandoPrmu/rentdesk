import { type InvoiceDocument, sanitizeDocument } from "./document.ts";
import { formatInvoiceCount, formatInvoiceDate, formatInvoiceMoney } from "./format.ts";
import {
  type Block,
  type Cell,
  COLOR,
  columns,
  type Fonts,
  keyValues,
  label,
  para,
  type PdfAssets,
  type PdfFonts,
  renderFramedPdf,
  type RenderResult,
  stack,
  tableRow,
  titleLine,
} from "./kit.ts";

export { wrapText } from "./kit.ts";
export type { RenderResult } from "./kit.ts";

/**
 * Invoice PDF (A4, server-side, pdf-lib; decision 33): the built-in template
 * (BRD-06: logo and company details at the top) or the owner's letterhead as the
 * page background with the invoice data in its data area (BRD-04/05). English
 * only: one embedded Latin font (Noto Sans, OFL), every string sanitised first.
 * The page frame (letterhead, shrink to fit, more pages, footer, stamps) is shared
 * with receipts (kit.ts). Only relative imports.
 */

export type InvoiceFonts = PdfFonts;
export type InvoiceAssets = PdfAssets;

export interface RenderOptions {
  /** Printed in the footer; null for the sample preview. */
  version: number | null;
  /** BRD-07 preview: a "SAMPLE" watermark. */
  sample?: boolean;
  warn?: (message: string) => void;
}

const KIND_LABEL = { NORMAL: null, ESTIMATED: "ESTIMATED", FINAL: "FINAL INVOICE" } as const;
const COUNTER_LABEL = { BW: "B&W", COLOUR: "Colour" } as const;

function titleBlock(doc: InvoiceDocument, f: Fonts): Block {
  const kind = KIND_LABEL[doc.kind];
  const title = titleLine("INVOICE", doc.invoiceNo, [
    { text: kind, color: COLOR.accent },
    { text: doc.cancelled ? "CANCELLED" : null, color: COLOR.red },
  ], f);
  const notes: string[] = [];
  if (doc.kind === "ESTIMATED") notes.push("Estimated charge: no meter reading was received for this period. It is credited on the next invoice with a reading.");
  if (doc.kind === "FINAL" && doc.partial) {
    notes.push(
      doc.partial.rule === "FULL"
        ? "Final invoice: the machine was returned. The last cycle is charged in full."
        : `Final invoice: the machine was returned. The last cycle is charged for ${doc.partial.daysUsed} of ${doc.partial.daysInCycle} days.`,
    );
  }
  const blocks = [title, ...notes.map((n) => para(n, { font: f.regular, size: 9, color: COLOR.accent }))];
  if (doc.cancelled) {
    const when = doc.cancelled.date ? ` on ${formatInvoiceDate(doc.cancelled.date)}` : "";
    const reason = doc.cancelled.reason ? `: ${doc.cancelled.reason.replace(/[.!?]*$/, "")}.` : ".";
    blocks.push(para(`This invoice was cancelled${when}${reason} Do not pay it.`, { font: f.bold, size: 9, color: COLOR.red }));
  }
  return stack(blocks, 4);
}

function partiesBlock(doc: InvoiceDocument, f: Fonts): Block {
  const c = doc.parties.customer;
  const billTo = stack([
    label("Bill to", f),
    para(c.name, { font: f.bold, size: 10 }),
    para(c.businessName ?? "", { font: f.regular, size: 9 }),
    para(c.address ?? "", { font: f.regular, size: 9, color: COLOR.muted }),
  ], 2);
  const period = `${formatInvoiceDate(doc.period.start)} – ${formatInvoiceDate(doc.period.end)}`;
  const rows: [string, string][] = [
    ["Invoice number", doc.invoiceNo],
    ["Issue date", formatInvoiceDate(doc.issueDate)],
    ["Due date", doc.dueDate ? formatInvoiceDate(doc.dueDate) : "On receipt"],
    ["Billing period", period],
    ["Cycles covered", doc.cycleNo ? `${doc.cyclesCovered} (cycle ${doc.cycleNo})` : String(doc.cyclesCovered)],
  ];
  return columns([
    { block: billTo, fraction: 0.5 },
    { block: keyValues(rows, f), fraction: 0.5 },
  ], 20);
}

function machineBlock(doc: InvoiceDocument, f: Fonts): Block {
  const m = doc.parties.machine;
  const details = [`Serial number: ${m.serialNo}`, m.location ? `Location: ${m.location}` : null].filter(Boolean).join("   ·   ");
  return stack([
    label("Machine", f),
    para(`${m.brand} ${m.model} (${m.type === "COLOUR" ? "Colour" : "Mono"})`, { font: f.bold, size: 9.5 }),
    para(details, { font: f.regular, size: 9, color: COLOR.muted }),
  ], 2);
}

function readingsBlocks(doc: InvoiceDocument, f: Fonts): Block[] {
  if (doc.counters.length === 0) return [];
  const fr = [0.24, 0.19, 0.19, 0.19, 0.19];
  const right = (text: string): Cell => ({ text, align: "right" });
  return [
    label("Meter readings", f),
    tableRow([{ text: "Counter" }, right("Previous"), right("Current"), right("Usage"), right("Included")], fr, f, { header: true, fill: COLOR.fill, size: 8 }),
    ...doc.counters.map((c) =>
      tableRow([
        { text: COUNTER_LABEL[c.counter] + (c.rolledOver ? " (meter rolled over)" : "") },
        right(formatInvoiceCount(c.previous)),
        right(formatInvoiceCount(c.current)),
        right(formatInvoiceCount(c.usage)),
        right(formatInvoiceCount(c.included)),
      ], fr, f),
    ),
  ];
}

/** Charges: one block per row, so a long invoice can continue on the next page. */
function lineBlocks(doc: InvoiceDocument, f: Fonts): Block[] {
  const fr = [0.5, 0.14, 0.16, 0.2];
  const right = (text: string, bold = false): Cell => ({ text, align: "right", bold });
  const priced = (t: InvoiceDocument["lines"][number]["type"]) => t === "COMMITMENT" || t === "BW_EXCESS" || t === "COLOUR_EXCESS";
  return [
    label("Charges", f),
    tableRow([{ text: "Description" }, right("Qty"), right("Rate"), right("Amount")], fr, f, { header: true, fill: COLOR.fill, size: 8 }),
    ...doc.lines.map((l) =>
      tableRow([
        { text: l.description },
        right(priced(l.type) ? formatInvoiceCount(l.quantity) : ""),
        right(priced(l.type) ? formatInvoiceMoney(l.rateCents) : ""),
        right(formatInvoiceMoney(l.amountCents)),
      ], fr, f),
    ),
    tableRow([{ text: "Total", bold: true }, right(""), right(""), right(formatInvoiceMoney(doc.totalCents), true)], fr, f, { fill: COLOR.total, size: 10.5, rule: false }),
  ];
}

function paymentBlock(doc: InvoiceDocument, f: Fonts): Block {
  const blocks: Block[] = [label("How to pay", f)];
  if (doc.cancelled) {
    blocks.push(para("This invoice is cancelled. Do not pay it.", { font: f.bold, size: 9, color: COLOR.red }));
    return stack(blocks, 3);
  }
  if (doc.bank) {
    const rows: [string, string][] = [["Bank", doc.bank.branch ? `${doc.bank.name}, ${doc.bank.branch}` : doc.bank.name]];
    if (doc.bank.accountName) rows.push(["Account name", doc.bank.accountName]);
    if (doc.bank.accountNo) rows.push(["Account number", doc.bank.accountNo]);
    blocks.push(keyValues(rows, f, { align: "left", keyFraction: 0.25 }));
  }
  const due = doc.dueDate ? ` by ${formatInvoiceDate(doc.dueDate)}` : "";
  blocks.push(para(`Please pay ${formatInvoiceMoney(doc.totalCents)}${due} and use ${doc.invoiceNo} as the payment reference. Then send the payment slip in the RentDesk app.`, { font: f.regular, size: 9 }));
  if (doc.paymentInstructions) blocks.push(para(doc.paymentInstructions, { font: f.regular, size: 9 }));
  return stack(blocks, 3);
}

/** Renders an invoice PDF. Never throws for bad text (it is sanitised); throws for broken fonts. */
export async function renderInvoicePdf(input: InvoiceDocument, assets: InvoiceAssets, fontBytes: InvoiceFonts, options: RenderOptions): Promise<RenderResult> {
  const warn = options.warn ?? ((m: string) => console.warn(`[invoice pdf] ${m}`));
  const doc = sanitizeDocument(input, (m) => warn(`${input.invoiceNo}: ${m}`));
  return renderFramedPdf({
    title: `Invoice ${doc.invoiceNo}`,
    author: doc.company.name,
    name: doc.invoiceNo,
    letterhead: doc.letterhead,
    company: doc.company,
    assets,
    fonts: fontBytes,
    blocks: (f) => [
      titleBlock(doc, f),
      partiesBlock(doc, f),
      machineBlock(doc, f),
      ...readingsBlocks(doc, f),
      ...lineBlocks(doc, f),
      paymentBlock(doc, f),
    ],
    stamps: [
      ...(doc.cancelled ? [{ text: "CANCELLED", color: "red" as const }] : []),
      ...(options.sample ? [{ text: "SAMPLE", color: "muted" as const }] : []),
    ],
    footer: [doc.company.name, `Invoice ${doc.invoiceNo}`, options.version ? `Version ${options.version}` : null].filter(Boolean).join("  ·  "),
    warn,
  });
}
