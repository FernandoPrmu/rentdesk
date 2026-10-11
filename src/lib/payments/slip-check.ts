import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

/**
 * Payment slip file checks (PAY-03, CLAUDE.md rule 6; decision 41), run on the
 * server on the bytes that reached storage, never on what the browser claims:
 * JPG, PNG or PDF by magic bytes, at most 5 MB, a picture that really decodes, a
 * PDF that opens without a password and carries no active content (JavaScript,
 * launch actions, embedded files, rich media, XFA forms). The SHA-256 is computed
 * here. A virus scan needs a paid or hosted scanner (deferred).
 * Only relative imports.
 */

export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
export const SLIP_MAX_PAGES = 10;

export type SlipMime = "image/jpeg" | "image/png" | "application/pdf";

export const SLIP_EXTENSION: Record<SlipMime, "jpg" | "png" | "pdf"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

export function sniffSlipType(bytes: Uint8Array): SlipMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  // "%PDF-" within the first 1 KB (some writers put a few bytes before it).
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "application/pdf";
  return null;
}

const ACTIVE_PDF_CONTENT: [RegExp, string][] = [
  [/\/JavaScript\b/, "JavaScript"],
  [/\/JS\b/, "JavaScript"],
  [/\/Launch\b/, "a launch action"],
  [/\/EmbeddedFiles?\b/, "an embedded file"],
  [/\/RichMedia\b/, "rich media"],
  [/\/XFA\b/, "an XFA form"],
];

/** Active content names found in the PDF's text (uncompressed objects and the trailer). */
export function pdfActiveContent(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  return [...new Set(ACTIVE_PDF_CONTENT.filter(([re]) => re.test(text)).map(([, what]) => what))];
}

export type SlipCheck =
  | { ok: true; mimeType: SlipMime; sizeBytes: number; sha256: string; pages: number | null }
  | { ok: false; error: string };

export async function checkSlipFile(bytes: Uint8Array): Promise<SlipCheck> {
  if (bytes.length === 0) return { ok: false, error: "The file is empty. Please choose the slip again." };
  if (bytes.length > SLIP_MAX_BYTES) return { ok: false, error: "The file is larger than 5 MB. Please take a new photo or choose a smaller file." };
  const mimeType = sniffSlipType(bytes);
  if (!mimeType) return { ok: false, error: "Please choose a JPG, PNG or PDF file." };

  let pages: number | null = null;
  if (mimeType === "application/pdf") {
    const active = pdfActiveContent(bytes);
    if (active.length > 0) {
      return { ok: false, error: `This PDF contains ${active.join(" and ")}, so it cannot be accepted. Please send a photo or a screenshot of the slip instead.` };
    }
    try {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      pages = pdf.getPageCount();
    } catch (error) {
      const encrypted = error instanceof Error && /encrypt/i.test(error.message);
      return { ok: false, error: encrypted ? "This PDF is protected with a password. Please send a photo or a screenshot of the slip instead." : "This PDF could not be opened. Please choose another file." };
    }
    if (pages < 1) return { ok: false, error: "This PDF has no pages." };
    if (pages > SLIP_MAX_PAGES) return { ok: false, error: `A slip PDF can have at most ${SLIP_MAX_PAGES} pages.` };
  } else {
    try {
      const meta = await sharp(bytes, { failOn: "error" }).metadata();
      const expected = mimeType === "image/png" ? "png" : "jpeg";
      if (meta.format !== expected || !meta.width || !meta.height) throw new Error("not a picture");
      // Decode it fully: a truncated or damaged file fails here.
      await sharp(bytes, { failOn: "error" }).resize(64, 64, { fit: "inside" }).raw().toBuffer();
    } catch {
      return { ok: false, error: "The picture could not be read. Please take it again or choose another file." };
    }
  }
  return { ok: true, mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), pages };
}
