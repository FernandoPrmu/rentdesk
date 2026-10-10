import fontkit from "@pdf-lib/fontkit";
import { type Color, degrees, PDFDocument, type PDFEmbeddedPage, type PDFFont, type PDFImage, type PDFPage, rgb } from "pdf-lib";

import { type InvoiceDocument, sanitizeDocument } from "./document.ts";
import { formatInvoiceCount, formatInvoiceDate, formatInvoiceMoney } from "./format.ts";
import { A4, areaToPoints } from "./layout.ts";

/**
 * Invoice PDF (A4, server-side, pdf-lib; decision 33): the built-in template
 * (BRD-06: logo and company details at the top) or the owner's letterhead as the
 * page background with the invoice data in its data area (BRD-04/05). English
 * only: one embedded Latin font (Noto Sans, OFL), every string sanitised first.
 * The content shrinks to fit the data area (down to 75 %), then flows onto more
 * pages with the letterhead repeated. Only relative imports.
 */

export interface InvoiceFonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface InvoiceAssets {
  logo: Uint8Array | null;
  letterhead: Uint8Array | null;
}

export interface RenderOptions {
  /** Printed in the footer; null for the sample preview. */
  version: number | null;
  /** BRD-07 preview: a "SAMPLE" watermark. */
  sample?: boolean;
  warn?: (message: string) => void;
}

export interface RenderResult {
  bytes: Uint8Array;
  template: "BUILT_IN" | "LETTERHEAD";
  pages: number;
}

const COLOR = {
  text: rgb(0.11, 0.12, 0.14),
  muted: rgb(0.4, 0.42, 0.46),
  rule: rgb(0.82, 0.84, 0.87),
  fill: rgb(0.95, 0.96, 0.97),
  total: rgb(0.9, 0.93, 0.97),
  accent: rgb(0.08, 0.3, 0.5),
  red: rgb(0.75, 0.1, 0.1),
};

const MARGIN = 40;
const FOOTER_HEIGHT = 20;
const MIN_SCALE = 0.75;
const BLOCK_GAP = 12;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** A piece of the invoice: measured and drawn at a width and scale. */
interface Block {
  measure(width: number, s: number): number;
  draw(page: PDFPage, x: number, top: number, width: number, s: number): void;
  /** Table rows follow the block above with a small gap. */
  tight?: boolean;
}

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Word wrap; explicit line breaks are kept, words longer than a line are broken. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidth;
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/).filter((w, i, all) => w !== "" || all.length === 1)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      let piece = "";
      for (const ch of word) {
        if (piece && !fits(piece + ch)) {
          out.push(piece);
          piece = ch;
        } else piece += ch;
      }
      line = piece;
    }
    out.push(line);
  }
  return out;
}

const lineHeight = (size: number) => size * 1.35;

interface TextStyle {
  font: PDFFont;
  size: number;
  color?: Color;
  align?: "left" | "right";
}

function drawLines(page: PDFPage, lines: string[], x: number, top: number, width: number, style: TextStyle) {
  lines.forEach((line, i) => {
    const w = style.font.widthOfTextAtSize(line, style.size);
    page.drawText(line, {
      x: style.align === "right" ? x + width - w : x,
      y: top - style.size - i * lineHeight(style.size),
      size: style.size,
      font: style.font,
      color: style.color ?? COLOR.text,
    });
  });
}

/** A wrapped paragraph. */
function para(text: string, style: Omit<TextStyle, "size"> & { size: number }): Block {
  return {
    measure: (width, s) => (text ? wrapText(text, style.font, style.size * s, width).length * lineHeight(style.size * s) : 0),
    draw: (page, x, top, width, s) => {
      if (text) drawLines(page, wrapText(text, style.font, style.size * s, width), x, top, width, { ...style, size: style.size * s });
    },
  };
}

/** Blocks on top of each other with a gap. */
function stack(blocks: Block[], gap = 0): Block {
  return {
    measure: (width, s) => blocks.reduce((h, b, i) => h + b.measure(width, s) + (i > 0 ? gap * s : 0), 0),
    draw: (page, x, top, width, s) => {
      let y = top;
      for (const b of blocks) {
        b.draw(page, x, y, width, s);
        y -= b.measure(width, s) + gap * s;
      }
    },
  };
}

/** Columns side by side (fractions of the width). */
function columns(cols: { block: Block; fraction: number }[], gap = 16): Block {
  const widths = (width: number, s: number) => {
    const free = width - gap * s * (cols.length - 1);
    return cols.map((c) => free * c.fraction);
  };
  return {
    measure: (width, s) => Math.max(...cols.map((c, i) => c.block.measure(widths(width, s)[i], s))),
    draw: (page, x, top, width, s) => {
      const ws = widths(width, s);
      let cx = x;
      cols.forEach((c, i) => {
        c.block.draw(page, cx, top, ws[i], s);
        cx += ws[i] + gap * s;
      });
    },
  };
}

interface Cell {
  text: string;
  align?: "left" | "right";
  bold?: boolean;
}

/** One table row; the first column wraps, the others are short values. */
function tableRow(cells: Cell[], fractions: number[], f: Fonts, o: { size?: number; fill?: Color; header?: boolean; rule?: boolean } = {}): Block {
  const pad = 4;
  const size = o.size ?? 9;
  const layout = (width: number, s: number) =>
    cells.map((c, i) => {
      const w = width * fractions[i];
      const font = c.bold || o.header ? f.bold : f.regular;
      return { c, w, font, lines: wrapText(c.text, font, size * s, w - pad * 2 * s) };
    });
  return {
    tight: true,
    measure: (width, s) => Math.max(...layout(width, s).map((l) => l.lines.length)) * lineHeight(size * s) + pad * 2 * s,
    draw: (page, x, top, width, s) => {
      const cellsLaid = layout(width, s);
      const h = Math.max(...cellsLaid.map((l) => l.lines.length)) * lineHeight(size * s) + pad * 2 * s;
      if (o.fill) page.drawRectangle({ x, y: top - h, width, height: h, color: o.fill });
      let cx = x;
      for (const l of cellsLaid) {
        drawLines(page, l.lines, cx + pad * s, top - pad * s, l.w - pad * 2 * s, {
          font: l.font,
          size: size * s,
          color: o.header ? COLOR.muted : COLOR.text,
          align: l.c.align,
        });
        cx += l.w;
      }
      if (o.rule !== false) page.drawLine({ start: { x, y: top - h }, end: { x: x + width, y: top - h }, thickness: 0.5, color: COLOR.rule });
    },
  };
}

function label(text: string, f: Fonts): Block {
  return para(text.toUpperCase(), { font: f.bold, size: 7.5, color: COLOR.muted });
}

/** "Label  value" rows. */
function keyValues(rows: [string, string][], f: Fonts, o: { align?: "left" | "right"; keyFraction?: number } = {}): Block {
  const keyFraction = o.keyFraction ?? 0.45;
  return stack(
    rows.map(([k, v]) => columns([
      { block: para(k, { font: f.regular, size: 9, color: COLOR.muted }), fraction: keyFraction },
      { block: para(v, { font: f.bold, size: 9, align: o.align ?? "right" }), fraction: 1 - keyFraction },
    ], 6)),
    2,
  );
}

function rule(): Block {
  return {
    measure: () => 1,
    draw: (page, x, top, width) => page.drawLine({ start: { x, y: top }, end: { x: x + width, y: top }, thickness: 0.75, color: COLOR.rule }),
  };
}

const KIND_LABEL = { NORMAL: null, ESTIMATED: "ESTIMATED", FINAL: "FINAL INVOICE" } as const;
const COUNTER_LABEL = { BW: "B&W", COLOUR: "Colour" } as const;

/** Company header of the built-in template (BRD-06). */
function companyHeader(doc: InvoiceDocument, f: Fonts, logo: PDFImage | null): Block {
  const details = stack([
    para(doc.company.name, { font: f.bold, size: 15, color: COLOR.accent }),
    para(doc.company.address ?? "", { font: f.regular, size: 9, color: COLOR.muted }),
    para([doc.company.phone, doc.company.email].filter(Boolean).join("  ·  "), { font: f.regular, size: 9, color: COLOR.muted }),
  ], 2);
  const logoSize = 58;
  if (!logo) return details;
  const dims = logo.scaleToFit(logoSize, logoSize);
  return {
    measure: (width, s) => Math.max(dims.height * s, details.measure(width - (logoSize + 12) * s, s)),
    draw: (page, x, top, width, s) => {
      page.drawImage(logo, { x, y: top - dims.height * s, width: dims.width * s, height: dims.height * s });
      details.draw(page, x + (logoSize + 12) * s, top, width - (logoSize + 12) * s, s);
    },
  };
}

function titleBlock(doc: InvoiceDocument, f: Fonts): Block {
  const kind = KIND_LABEL[doc.kind];
  const title: Block = {
    measure: (_w, s) => lineHeight(20 * s),
    draw: (page, x, top, width, s) => {
      page.drawText("INVOICE", { x, y: top - 20 * s, size: 20 * s, font: f.bold, color: COLOR.text });
      let lx = x + f.bold.widthOfTextAtSize("INVOICE", 20 * s) + 10 * s;
      for (const [text, color] of [[kind, COLOR.accent], [doc.cancelled ? "CANCELLED" : null, COLOR.red]] as const) {
        if (!text) continue;
        const size = 8 * s;
        const w = f.bold.widthOfTextAtSize(text, size) + 10 * s;
        page.drawRectangle({ x: lx, y: top - 19 * s, width: w, height: 14 * s, borderColor: color, borderWidth: 1, color: rgb(1, 1, 1) });
        page.drawText(text, { x: lx + 5 * s, y: top - 15 * s, size, font: f.bold, color });
        lx += w + 6 * s;
      }
      const no = doc.invoiceNo;
      page.drawText(no, { x: x + width - f.bold.widthOfTextAtSize(no, 12 * s), y: top - 16 * s, size: 12 * s, font: f.bold, color: COLOR.text });
    },
  };
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

function stamp(page: PDFPage, text: string, font: PDFFont, color: Color) {
  const size = 84;
  const width = font.widthOfTextAtSize(text, size);
  const angle = (35 * Math.PI) / 180;
  const cx = A4.width / 2;
  const cy = A4.height / 2;
  // Rotate about the start of the baseline: move back half the width along the angle.
  page.drawText(text, {
    x: cx - (width / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
    y: cy - (width / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
    size,
    font,
    color,
    opacity: 0.16,
    rotate: degrees(35),
  });
}

/** Renders an invoice PDF. Never throws for bad text (it is sanitised); throws for broken fonts. */
export async function renderInvoicePdf(input: InvoiceDocument, assets: InvoiceAssets, fontBytes: InvoiceFonts, options: RenderOptions): Promise<RenderResult> {
  const warn = options.warn ?? ((m: string) => console.warn(`[invoice pdf] ${m}`));
  const doc = sanitizeDocument(input, (m) => warn(`${input.invoiceNo}: ${m}`));

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f: Fonts = {
    regular: await pdf.embedFont(fontBytes.regular, { subset: true }),
    bold: await pdf.embedFont(fontBytes.bold, { subset: true }),
  };
  pdf.setTitle(`Invoice ${doc.invoiceNo}`);
  pdf.setAuthor(doc.company.name);
  pdf.setCreator("RentDesk");
  pdf.setProducer("RentDesk");

  // Letterhead background (BRD-04): an A4 image or page 1 of a PDF, stretched to the page.
  let background: { image?: PDFImage; page?: PDFEmbeddedPage } | null = null;
  if (doc.letterhead && assets.letterhead) {
    try {
      if (doc.letterhead.kind === "PDF") background = { page: (await pdf.embedPdf(assets.letterhead, [0]))[0] };
      else if (isPng(assets.letterhead)) background = { image: await pdf.embedPng(assets.letterhead) };
      else if (isJpeg(assets.letterhead)) background = { image: await pdf.embedJpg(assets.letterhead) };
      else warn(`${doc.invoiceNo}: letterhead is not a PDF, PNG or JPEG; built-in template used`);
    } catch (error) {
      warn(`${doc.invoiceNo}: letterhead could not be used (${error instanceof Error ? error.message : String(error)}); built-in template used`);
      background = null;
    }
  }

  let logo: PDFImage | null = null;
  if (!background && assets.logo) {
    try {
      logo = isPng(assets.logo) ? await pdf.embedPng(assets.logo) : isJpeg(assets.logo) ? await pdf.embedJpg(assets.logo) : null;
    } catch (error) {
      warn(`${doc.invoiceNo}: logo skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const area = background && doc.letterhead
    ? areaToPoints(doc.letterhead.layout.area)
    : { x: MARGIN, y: MARGIN, width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 };

  const blocks: Block[] = [
    ...(background ? [] : [companyHeader(doc, f, logo), rule()]),
    titleBlock(doc, f),
    partiesBlock(doc, f),
    machineBlock(doc, f),
    ...readingsBlocks(doc, f),
    ...lineBlocks(doc, f),
    paymentBlock(doc, f),
  ];
  // Rows of a table sit together; other blocks are separated by a gap.
  const gapBefore = (i: number, s: number) => (i === 0 ? 0 : (blocks[i].tight ? 2 : BLOCK_GAP) * s);
  const contentHeight = area.height - FOOTER_HEIGHT;
  const total = (s: number) => blocks.reduce((h, b, i) => h + gapBefore(i, s) + b.measure(area.width, s), 0);

  let s = 1;
  if (total(1) > contentHeight) {
    s = Math.max(MIN_SCALE, contentHeight / total(1));
    while (s > MIN_SCALE && total(s) > contentHeight) s = Math.max(MIN_SCALE, s - 0.02);
  }

  const newPage = () => {
    const page = pdf.addPage([A4.width, A4.height]);
    if (background?.page) page.drawPage(background.page, { x: 0, y: 0, width: A4.width, height: A4.height });
    if (background?.image) page.drawImage(background.image, { x: 0, y: 0, width: A4.width, height: A4.height });
    return page;
  };

  const pages: PDFPage[] = [newPage()];
  const top = area.y + area.height;
  const bottom = area.y + FOOTER_HEIGHT;
  let y = top;
  blocks.forEach((b, i) => {
    const h = b.measure(area.width, s);
    const gap = y === top ? 0 : gapBefore(i, s);
    if (y - gap - h < bottom && y !== top) {
      pages.push(newPage());
      y = top;
    } else y -= gap;
    b.draw(pages[pages.length - 1], area.x, y, area.width, s);
    y -= h;
  });

  pages.forEach((page, i) => {
    if (doc.cancelled) stamp(page, "CANCELLED", f.bold, COLOR.red);
    if (options.sample) stamp(page, "SAMPLE", f.bold, COLOR.muted);
    const left = [doc.company.name, `Invoice ${doc.invoiceNo}`, options.version ? `Version ${options.version}` : null].filter(Boolean).join("  ·  ");
    const right = `Page ${i + 1} of ${pages.length}`;
    const size = 7.5;
    page.drawLine({ start: { x: area.x, y: area.y + 12 }, end: { x: area.x + area.width, y: area.y + 12 }, thickness: 0.5, color: COLOR.rule });
    const leftText = wrapText(left, f.regular, size, area.width - f.regular.widthOfTextAtSize(right, size) - 12)[0] ?? "";
    page.drawText(leftText, { x: area.x, y: area.y + 2, size, font: f.regular, color: COLOR.muted });
    page.drawText(right, { x: area.x + area.width - f.regular.widthOfTextAtSize(right, size), y: area.y + 2, size, font: f.regular, color: COLOR.muted });
  });

  return { bytes: await pdf.save(), template: background ? "LETTERHEAD" : "BUILT_IN", pages: pages.length };
}
