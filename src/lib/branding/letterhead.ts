import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { a4Check } from "../invoices/pdf/layout.ts";

import type { LetterheadExt } from "./files.ts";
import { LETTERHEAD_MAX_BYTES } from "./letterhead-limits.ts";

/**
 * Letterhead upload checks (BRD-04; decision 36). The real type comes from the
 * magic bytes, never the browser: a JPG/PNG image or a PDF of exactly one page,
 * at most 5 MB, not password-protected. A file that is not A4 portrait (within
 * 3 %) is accepted with a warning: it is stretched to the page. Images are
 * re-encoded (EXIF rotation applied, metadata dropped, at most A4 at 300 dpi) so
 * the PDFs stay light.
 */

/** A4 at 300 dpi. */
const MAX_IMAGE = { width: 2480, height: 3508 };
/** Below about 100 dpi on A4 a letterhead looks blurry when printed. */
const MIN_IMAGE_WIDTH = 800;

export type LetterheadType = "pdf" | "png" | "jpeg";

export type LetterheadCheck =
  | { ok: true; bytes: Uint8Array; ext: LetterheadExt; kind: "PDF" | "IMAGE"; width: number; height: number; warning: string | null }
  | { ok: false; error: string };

export function letterheadType(bytes: Uint8Array): LetterheadType | null {
  const starts = (magic: number[]) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpeg";
  return null;
}

/** The A4 warning shown to the owner, or null for an A4 portrait page. */
export function a4Warning(width: number, height: number): string | null {
  const check = a4Check(width, height);
  if (check.ok) return null;
  if (check.landscape) return "This file is landscape. Invoices are A4 portrait, so it will be stretched to fit. Check the preview.";
  return "This file is not A4 size. It will be stretched to fit an A4 page. Check the preview.";
}

export async function checkLetterhead(bytes: Uint8Array): Promise<LetterheadCheck> {
  if (bytes.length === 0) return { ok: false, error: "Choose a file." };
  if (bytes.length > LETTERHEAD_MAX_BYTES) return { ok: false, error: "The file is too large. The limit is 5 MB." };
  const type = letterheadType(bytes);
  if (!type) return { ok: false, error: "Use a PDF, JPG or PNG file." };

  if (type === "pdf") {
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
      const encrypted = error instanceof Error && /encrypt/i.test(error.message);
      return { ok: false, error: encrypted ? "This PDF is password-protected. Upload one without a password." : "This PDF could not be read. Try saving it again as a PDF." };
    }
    if (doc.getPageCount() !== 1) return { ok: false, error: "The PDF must have exactly 1 page." };
    try {
      await (await PDFDocument.create()).embedPdf(bytes, [0]);
    } catch {
      return { ok: false, error: "This PDF could not be used as a letterhead. Try saving it again as a PDF." };
    }
    const page = doc.getPage(0);
    const { width, height } = page.getSize();
    const turned = page.getRotation().angle % 180 !== 0;
    const [w, h] = turned ? [height, width] : [width, height];
    return { ok: true, bytes, ext: "pdf", kind: "PDF", width: w, height: h, warning: a4Warning(w, h) };
  }

  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate();
    const resized = image.resize({ ...MAX_IMAGE, fit: "inside", withoutEnlargement: true });
    const { data, info } = type === "png"
      ? await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const warnings = [a4Warning(info.width, info.height), info.width < MIN_IMAGE_WIDTH ? "The image is small, so it may look blurry when printed." : null].filter(Boolean);
    return {
      ok: true,
      bytes: new Uint8Array(data),
      ext: type === "png" ? "png" : "jpg",
      kind: "IMAGE",
      width: info.width,
      height: info.height,
      warning: warnings.length ? warnings.join(" ") : null,
    };
  } catch {
    return { ok: false, error: "This image could not be read. Try another JPG or PNG file." };
  }
}
