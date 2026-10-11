import { sanitizeDocument } from "../../invoices/pdf/document.ts";
import { formatInvoiceDate, formatInvoiceMoney } from "../../invoices/pdf/format.ts";
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
} from "../../invoices/pdf/kit.ts";

import type { ReceiptDocument } from "./document.ts";

/**
 * Receipt PDF (decision 44): the same A4 frame as invoices (letterhead or
 * built-in header, shrink to fit, footer) with the payment, the bills it paid and
 * what is left on each, the credit kept, and the customer's remaining balance. A
 * reversed receipt carries a REVERSED stamp. Only relative imports.
 */

function titleBlock(doc: ReceiptDocument, f: Fonts): Block {
  const blocks: Block[] = [titleLine("RECEIPT", doc.receiptNo, [{ text: doc.reversed ? "REVERSED" : null, color: COLOR.red }], f)];
  if (doc.reversed) {
    const when = doc.reversed.date ? ` on ${formatInvoiceDate(doc.reversed.date)}` : "";
    const reason = doc.reversed.reason ? `: ${doc.reversed.reason.replace(/[.!?]*$/, "")}.` : ".";
    blocks.push(para(`This payment was reversed${when}${reason} This receipt is no longer valid; the bills below are to pay again.`, { font: f.bold, size: 9, color: COLOR.red }));
  }
  if (doc.reallocated) {
    const when = doc.reallocated.date ? ` on ${formatInvoiceDate(doc.reallocated.date)}` : "";
    blocks.push(para(`Updated${when}: the payment was moved to the bills below (${doc.reallocated.reason.replace(/[.!?]*$/, "")}).`, { font: f.regular, size: 9, color: COLOR.accent }));
  }
  return stack(blocks, 4);
}

function partiesBlock(doc: ReceiptDocument, f: Fonts): Block {
  const c = doc.customer;
  const from = stack([
    label("Received from", f),
    para(c.name, { font: f.bold, size: 10 }),
    para(c.businessName ?? "", { font: f.regular, size: 9 }),
    para(c.address ?? "", { font: f.regular, size: 9, color: COLOR.muted }),
  ], 2);
  const rows: [string, string][] = [
    ["Receipt number", doc.receiptNo],
    ["Receipt date", formatInvoiceDate(doc.issueDate)],
    ["Paid on", formatInvoiceDate(doc.payment.paidOn)],
    ["Method", doc.payment.method],
  ];
  if (doc.payment.reference) rows.push(["Reference", doc.payment.reference]);
  if (doc.payment.slipCents !== doc.payment.receivedCents) rows.push(["Amount on the slip", formatInvoiceMoney(doc.payment.slipCents)]);
  return columns([
    { block: from, fraction: 0.5 },
    { block: keyValues(rows, f), fraction: 0.5 },
  ], 20);
}

function amountBlock(doc: ReceiptDocument, f: Fonts): Block {
  return stack([
    label("Amount received", f),
    para(formatInvoiceMoney(doc.payment.receivedCents), { font: f.bold, size: 18, color: doc.reversed ? COLOR.muted : COLOR.accent }),
  ], 2);
}

function lineBlocks(doc: ReceiptDocument, f: Fonts): Block[] {
  const fr = [0.2, 0.4, 0.2, 0.2];
  const right = (t: string, bold = false): Cell => ({ text: t, align: "right", bold });
  const rows: Block[] = [label("Paid on these bills", f), tableRow([{ text: "Bill" }, { text: "Machine and period" }, right("Paid"), right("Left to pay")], fr, f, { header: true, fill: COLOR.fill, size: 8 })];
  if (doc.lines.length === 0) rows.push(para("No bill: the whole amount is kept as credit.", { font: f.regular, size: 9, color: COLOR.muted }));
  for (const l of doc.lines) {
    rows.push(
      tableRow([
        { text: l.invoiceNo },
        { text: `${l.machine}, ${formatInvoiceDate(l.period.start)} – ${formatInvoiceDate(l.period.end)}` },
        right(formatInvoiceMoney(l.appliedCents)),
        right(formatInvoiceMoney(l.balanceAfterCents)),
      ], fr, f),
    );
  }
  if (doc.creditCents > 0) {
    rows.push(tableRow([{ text: "Credit" }, { text: "Kept for your next bills" }, right(formatInvoiceMoney(doc.creditCents)), right("")], fr, f));
  }
  rows.push(tableRow([{ text: "Total", bold: true }, { text: "" }, right(formatInvoiceMoney(doc.payment.receivedCents), true), right("")], fr, f, { fill: COLOR.total, size: 10.5, rule: false }));
  return rows;
}

function balanceBlock(doc: ReceiptDocument, f: Fonts): Block {
  const balance =
    doc.outstandingAfterCents > 0
      ? `Balance on your account after this payment: ${formatInvoiceMoney(doc.outstandingAfterCents)} (on ${formatInvoiceDate(doc.issueDate)}).`
      : `Nothing was left to pay on your account after this payment (on ${formatInvoiceDate(doc.issueDate)}).`;
  return stack([
    para(balance, { font: f.bold, size: 9.5 }),
    para(doc.reversed ? "" : "Thank you for your payment.", { font: f.regular, size: 9, color: COLOR.muted }),
  ], 4);
}

export interface ReceiptRenderOptions {
  version: number | null;
  warn?: (message: string) => void;
}

/** Renders a receipt PDF. Never throws for bad text (it is sanitised); throws for broken fonts. */
export async function renderReceiptPdf(input: ReceiptDocument, assets: PdfAssets, fonts: PdfFonts, options: ReceiptRenderOptions): Promise<RenderResult> {
  const warn = options.warn ?? ((m: string) => console.warn(`[receipt pdf] ${m}`));
  const doc = sanitizeDocument(input, (m) => warn(`${input.receiptNo}: ${m}`));
  return renderFramedPdf({
    title: `Receipt ${doc.receiptNo}`,
    author: doc.company.name,
    name: doc.receiptNo,
    letterhead: doc.letterhead,
    company: doc.company,
    assets,
    fonts,
    blocks: (f) => [titleBlock(doc, f), partiesBlock(doc, f), amountBlock(doc, f), ...lineBlocks(doc, f), balanceBlock(doc, f)],
    stamps: doc.reversed ? [{ text: "REVERSED", color: "red" }] : [],
    footer: [doc.company.name, `Receipt ${doc.receiptNo}`, options.version ? `Version ${options.version}` : null].filter(Boolean).join("  ·  "),
    warn,
  });
}
