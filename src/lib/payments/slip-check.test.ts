import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { checkSlipFile, pdfActiveContent, SLIP_MAX_BYTES, sniffSlipType } from "./slip-check";

let png: Uint8Array;
let jpeg: Uint8Array;
let pdf: Uint8Array;

beforeAll(async () => {
  const image = sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 220, b: 240 } } });
  png = new Uint8Array(await image.clone().png().toBuffer());
  jpeg = new Uint8Array(await image.clone().jpeg().toBuffer());
  const doc = await PDFDocument.create();
  doc.addPage([200, 100]).drawText("Bank slip");
  pdf = await doc.save();
});

describe("payment slip checks (PAY-03, decision 41)", () => {
  it("knows JPG, PNG and PDF by their first bytes, not their name", () => {
    expect(sniffSlipType(jpeg)).toBe("image/jpeg");
    expect(sniffSlipType(png)).toBe("image/png");
    expect(sniffSlipType(pdf)).toBe("application/pdf");
    expect(sniffSlipType(new TextEncoder().encode("MZ fake.pdf"))).toBeNull();
    expect(sniffSlipType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("accepts real files and returns the SHA-256 of the stored bytes", async () => {
    for (const [bytes, mime] of [[jpeg, "image/jpeg"], [png, "image/png"], [pdf, "application/pdf"]] as const) {
      const r = await checkSlipFile(bytes);
      expect(r).toEqual({ ok: true, mimeType: mime, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), pages: mime === "application/pdf" ? 1 : null });
    }
  });

  it("refuses empty, oversized, renamed and broken files with a clear message", async () => {
    expect(await checkSlipFile(new Uint8Array())).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    const big = new Uint8Array(SLIP_MAX_BYTES + 1);
    big.set(jpeg.subarray(0, 3));
    expect(await checkSlipFile(big)).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 5 MB/) });
    expect(await checkSlipFile(new TextEncoder().encode("hello, I am a .exe"))).toMatchObject({ ok: false, error: "Please choose a JPG, PNG or PDF file." });
    expect(await checkSlipFile(jpeg.subarray(0, 40))).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });
    expect(await checkSlipFile(new TextEncoder().encode("%PDF-1.7 not really"))).toMatchObject({ ok: false, error: expect.stringMatching(/could not be opened/) });
  });

  it("refuses PDFs with active content", async () => {
    const withScript = new Uint8Array([...pdf, ...new TextEncoder().encode("\n9 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n")]);
    expect(pdfActiveContent(withScript)).toEqual(["JavaScript"]);
    expect(await checkSlipFile(withScript)).toMatchObject({ ok: false, error: expect.stringMatching(/contains JavaScript/) });
    const withFile = new Uint8Array([...pdf, ...new TextEncoder().encode("\n<< /EmbeddedFiles 3 0 R /Launch 4 0 R >>\n")]);
    expect(pdfActiveContent(withFile)).toEqual(["a launch action", "an embedded file"]);
    expect(pdfActiveContent(pdf)).toEqual([]);
  });
});
