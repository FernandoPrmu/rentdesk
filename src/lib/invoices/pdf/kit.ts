import fontkit from "@pdf-lib/fontkit";
import { type Color, degrees, PDFDocument, type PDFEmbeddedPage, type PDFFont, type PDFImage, type PDFPage, rgb } from "pdf-lib";

import type { LetterheadRef } from "./document.ts";
import { A4, areaToPoints } from "./layout.ts";

/**
 * The page frame and drawing blocks shared by invoice and receipt PDFs (decisions
 * 33, 36, 44): A4, the built-in company header (BRD-06) or the owner's letterhead
 * as the page background with the content in its data area (BRD-04/05), one
 * embedded Latin font, content that shrinks to fit (down to 75 %) and then flows
 * onto more pages with the letterhead repeated, a footer on every page and
 * optional diagonal stamps (CANCELLED, REVERSED, SAMPLE). Only relative imports.
 */

export interface PdfFonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface PdfAssets {
  logo: Uint8Array | null;
  letterhead: Uint8Array | null;
}

export interface RenderResult {
  bytes: Uint8Array;
  template: "BUILT_IN" | "LETTERHEAD";
  pages: number;
}

export const COLOR = {
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

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** A piece of the document: measured and drawn at a width and scale. */
export interface Block {
  measure(width: number, s: number): number;
  draw(page: PDFPage, x: number, top: number, width: number, s: number): void;
  /** Table rows follow the block above with a small gap. */
  tight?: boolean;
}

export const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

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

export const lineHeight = (size: number) => size * 1.35;

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
export function para(text: string, style: Omit<TextStyle, "size"> & { size: number }): Block {
  return {
    measure: (width, s) => (text ? wrapText(text, style.font, style.size * s, width).length * lineHeight(style.size * s) : 0),
    draw: (page, x, top, width, s) => {
      if (text) drawLines(page, wrapText(text, style.font, style.size * s, width), x, top, width, { ...style, size: style.size * s });
    },
  };
}

/** Blocks on top of each other with a gap. */
export function stack(blocks: Block[], gap = 0): Block {
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
export function columns(cols: { block: Block; fraction: number }[], gap = 16): Block {
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

export interface Cell {
  text: string;
  align?: "left" | "right";
  bold?: boolean;
}

/** One table row; the first column wraps, the others are short values. */
export function tableRow(cells: Cell[], fractions: number[], f: Fonts, o: { size?: number; fill?: Color; header?: boolean; rule?: boolean } = {}): Block {
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

export function label(text: string, f: Fonts): Block {
  return para(text.toUpperCase(), { font: f.bold, size: 7.5, color: COLOR.muted });
}

/** "Label  value" rows. */
export function keyValues(rows: [string, string][], f: Fonts, o: { align?: "left" | "right"; keyFraction?: number } = {}): Block {
  const keyFraction = o.keyFraction ?? 0.45;
  return stack(
    rows.map(([k, v]) => columns([
      { block: para(k, { font: f.regular, size: 9, color: COLOR.muted }), fraction: keyFraction },
      { block: para(v, { font: f.bold, size: 9, align: o.align ?? "right" }), fraction: 1 - keyFraction },
    ], 6)),
    2,
  );
}

export function rule(): Block {
  return {
    measure: () => 1,
    draw: (page, x, top, width) => page.drawLine({ start: { x, y: top }, end: { x: x + width, y: top }, thickness: 0.75, color: COLOR.rule }),
  };
}

/** A document title ("INVOICE", "RECEIPT") with outlined tags after it and its number on the right. */
export function titleLine(title: string, number: string, tags: { text: string | null; color: Color }[], f: Fonts): Block {
  return {
    measure: (_w, s) => lineHeight(20 * s),
    draw: (page, x, top, width, s) => {
      page.drawText(title, { x, y: top - 20 * s, size: 20 * s, font: f.bold, color: COLOR.text });
      let lx = x + f.bold.widthOfTextAtSize(title, 20 * s) + 10 * s;
      for (const { text, color } of tags) {
        if (!text) continue;
        const size = 8 * s;
        const w = f.bold.widthOfTextAtSize(text, size) + 10 * s;
        page.drawRectangle({ x: lx, y: top - 19 * s, width: w, height: 14 * s, borderColor: color, borderWidth: 1, color: rgb(1, 1, 1) });
        page.drawText(text, { x: lx + 5 * s, y: top - 15 * s, size, font: f.bold, color });
        lx += w + 6 * s;
      }
      page.drawText(number, { x: x + width - f.bold.widthOfTextAtSize(number, 12 * s), y: top - 16 * s, size: 12 * s, font: f.bold, color: COLOR.text });
    },
  };
}

export interface Company {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/** Company header of the built-in template (BRD-06). */
export function companyHeader(company: Company, f: Fonts, logo: PDFImage | null): Block {
  const details = stack([
    para(company.name, { font: f.bold, size: 15, color: COLOR.accent }),
    para(company.address ?? "", { font: f.regular, size: 9, color: COLOR.muted }),
    para([company.phone, company.email].filter(Boolean).join("  ·  "), { font: f.regular, size: 9, color: COLOR.muted }),
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

export interface FramedPdf {
  /** PDF metadata. */
  title: string;
  author: string;
  /** Short name for warnings ("INV-000012"). */
  name: string;
  letterhead: LetterheadRef | null;
  company: Company;
  assets: PdfAssets;
  fonts: PdfFonts;
  /** The content blocks, below the company header (built-in template only). */
  blocks: (f: Fonts) => Block[];
  /** Diagonal stamps on every page. */
  stamps: { text: string; color: "red" | "muted" }[];
  /** Footer text before "Page n of m". */
  footer: string;
  warn: (message: string) => void;
}

/** Lays the blocks out on A4 pages, with the letterhead or the built-in header, footer and stamps. */
export async function renderFramedPdf(input: FramedPdf): Promise<RenderResult> {
  const { warn, name } = input;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const f: Fonts = {
    regular: await pdf.embedFont(input.fonts.regular, { subset: true }),
    bold: await pdf.embedFont(input.fonts.bold, { subset: true }),
  };
  pdf.setTitle(input.title);
  pdf.setAuthor(input.author);
  pdf.setCreator("RentDesk");
  pdf.setProducer("RentDesk");

  // Letterhead background (BRD-04): an A4 image or page 1 of a PDF, stretched to the page.
  let background: { image?: PDFImage; page?: PDFEmbeddedPage } | null = null;
  const letterheadBytes = input.assets.letterhead;
  if (input.letterhead && letterheadBytes) {
    try {
      if (input.letterhead.kind === "PDF") background = { page: (await pdf.embedPdf(letterheadBytes, [0]))[0] };
      else if (isPng(letterheadBytes)) background = { image: await pdf.embedPng(letterheadBytes) };
      else if (isJpeg(letterheadBytes)) background = { image: await pdf.embedJpg(letterheadBytes) };
      else warn(`${name}: letterhead is not a PDF, PNG or JPEG; built-in template used`);
    } catch (error) {
      warn(`${name}: letterhead could not be used (${error instanceof Error ? error.message : String(error)}); built-in template used`);
      background = null;
    }
  }

  let logo: PDFImage | null = null;
  if (!background && input.assets.logo) {
    try {
      const bytes = input.assets.logo;
      logo = isPng(bytes) ? await pdf.embedPng(bytes) : isJpeg(bytes) ? await pdf.embedJpg(bytes) : null;
    } catch (error) {
      warn(`${name}: logo skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const area = background && input.letterhead
    ? areaToPoints(input.letterhead.layout.area)
    : { x: MARGIN, y: MARGIN, width: A4.width - MARGIN * 2, height: A4.height - MARGIN * 2 };

  const blocks: Block[] = [...(background ? [] : [companyHeader(input.company, f, logo), rule()]), ...input.blocks(f)];
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
    for (const st of input.stamps) stamp(page, st.text, f.bold, st.color === "red" ? COLOR.red : COLOR.muted);
    const right = `Page ${i + 1} of ${pages.length}`;
    const size = 7.5;
    page.drawLine({ start: { x: area.x, y: area.y + 12 }, end: { x: area.x + area.width, y: area.y + 12 }, thickness: 0.5, color: COLOR.rule });
    const leftText = wrapText(input.footer, f.regular, size, area.width - f.regular.widthOfTextAtSize(right, size) - 12)[0] ?? "";
    page.drawText(leftText, { x: area.x, y: area.y + 2, size, font: f.regular, color: COLOR.muted });
    page.drawText(right, { x: area.x + area.width - f.regular.widthOfTextAtSize(right, size), y: area.y + 2, size, font: f.regular, color: COLOR.muted });
  });

  return { bytes: await pdf.save(), template: background ? "LETTERHEAD" : "BUILT_IN", pages: pages.length };
}
