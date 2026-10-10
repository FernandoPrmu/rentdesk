import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { letterheadFilePath, logoFilePath, isOwnLetterheadPath, sha256Hex } from "./files";
import { checkLetterhead, letterheadType } from "./letterhead";
import { LETTERHEAD_MAX_BYTES } from "./letterhead-limits";

const OWNER = "02f15e3d-804f-464a-aecb-a9c13ce16d85";

async function pdf(pages: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of pages) doc.addPage(size);
  return doc.save();
}

async function image(width: number, height: number, format: "png" | "jpeg"): Promise<Uint8Array> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 15, g: 76, b: 129 } } });
  return new Uint8Array(await (format === "png" ? base.png() : base.jpeg()).toBuffer());
}

describe("letterhead checks (BRD-04, decision 36)", () => {
  it("reads the real type from the magic bytes", async () => {
    expect(letterheadType(await pdf([[595.28, 841.89]]))).toBe("pdf");
    expect(letterheadType(await image(10, 14, "png"))).toBe("png");
    expect(letterheadType(await image(10, 14, "jpeg"))).toBe("jpeg");
    expect(letterheadType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(letterheadType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("accepts a one-page A4 PDF without a warning", async () => {
    const r = await checkLetterhead(await pdf([[595.28, 841.89]]));
    expect(r).toMatchObject({ ok: true, ext: "pdf", kind: "PDF", warning: null });
  });

  it("refuses a PDF with more than one page, an unreadable PDF and other file types", async () => {
    expect(await checkLetterhead(await pdf([[595.28, 841.89], [595.28, 841.89]]))).toEqual({ ok: false, error: "The PDF must have exactly 1 page." });
    expect(await checkLetterhead(new TextEncoder().encode("%PDF-1.7 garbage"))).toMatchObject({ ok: false });
    expect(await checkLetterhead(new TextEncoder().encode("hello"))).toEqual({ ok: false, error: "Use a PDF, JPG or PNG file." });
    expect(await checkLetterhead(new Uint8Array(0))).toEqual({ ok: false, error: "Choose a file." });
  });

  it("refuses files over 5 MB", async () => {
    const big = new Uint8Array(LETTERHEAD_MAX_BYTES + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(await checkLetterhead(big)).toEqual({ ok: false, error: "The file is too large. The limit is 5 MB." });
  });

  it("warns (but accepts) when the page is not A4 portrait", async () => {
    const letter = await checkLetterhead(await pdf([[612, 792]]));
    expect(letter).toMatchObject({ ok: true, warning: expect.stringMatching(/not A4/) });
    const landscape = await checkLetterhead(await pdf([[841.89, 595.28]]));
    expect(landscape).toMatchObject({ ok: true, warning: expect.stringMatching(/landscape/) });
  });

  it("re-encodes images (at most A4 at 300 dpi) and warns about small or non-A4 ones", async () => {
    const big = await checkLetterhead(await image(3000, 4243, "png"));
    expect(big).toMatchObject({ ok: true, ext: "png", kind: "IMAGE", warning: null });
    if (big.ok) expect(big.height).toBeLessThanOrEqual(3508);
    const jpg = await checkLetterhead(await image(1240, 1754, "jpeg"));
    expect(jpg).toMatchObject({ ok: true, ext: "jpg", warning: null });
    const square = await checkLetterhead(await image(600, 600, "jpeg"));
    expect(square).toMatchObject({ ok: true, warning: expect.stringMatching(/not A4[\s\S]*small/) });
  });
});

describe("immutable branding files (decision 35)", () => {
  it("paths come from the content, so a new file never overwrites an old one", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(letterheadFilePath(OWNER, a, "pdf")).toBe(`${OWNER}/letterheads/${sha256Hex(a)}.pdf`);
    expect(letterheadFilePath(OWNER, a, "pdf")).not.toBe(letterheadFilePath(OWNER, b, "pdf"));
    expect(logoFilePath(OWNER, a)).toBe(`${OWNER}/logos/${sha256Hex(a)}.png`);
  });

  it("only the owner's own letterhead paths are accepted", () => {
    const path = letterheadFilePath(OWNER, new Uint8Array([1]), "png");
    expect(isOwnLetterheadPath(OWNER, path)).toBe(true);
    expect(isOwnLetterheadPath("00000000-0000-4000-8000-000000000001", path)).toBe(false);
    expect(isOwnLetterheadPath(OWNER, `${OWNER}/logo.png`)).toBe(false);
    expect(isOwnLetterheadPath(OWNER, `${OWNER}/letterheads/../../x.pdf`)).toBe(false);
  });
});
