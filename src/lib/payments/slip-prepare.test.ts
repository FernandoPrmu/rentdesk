import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex, slipExtension, slipPlan } from "./slip-prepare";

const MB = 1024 * 1024;

describe("preparing a slip on the phone (decision 41)", () => {
  it("sends small JPG and PNG pictures and PDFs as they are", () => {
    expect(slipPlan({ type: "image/jpeg", size: MB, name: "slip.jpg" })).toEqual({ action: "UPLOAD", mimeType: "image/jpeg" });
    expect(slipPlan({ type: "image/png", size: 2 * MB, name: "s.png" })).toEqual({ action: "UPLOAD", mimeType: "image/png" });
    expect(slipPlan({ type: "application/pdf", size: 4 * MB, name: "s.pdf" })).toEqual({ action: "UPLOAD", mimeType: "application/pdf" });
    expect(slipPlan({ type: "", size: MB, name: "bank.PDF" })).toEqual({ action: "UPLOAD", mimeType: "application/pdf" });
  });

  it("makes large pictures and other picture formats smaller", () => {
    expect(slipPlan({ type: "image/jpeg", size: 6 * MB, name: "camera.jpg" })).toEqual({ action: "COMPRESS" });
    expect(slipPlan({ type: "image/heic", size: MB, name: "IMG_1.HEIC" })).toEqual({ action: "COMPRESS" });
  });

  it("refuses empty files, other types and PDFs over 5 MB", () => {
    expect(slipPlan({ type: "image/jpeg", size: 0, name: "x.jpg" })).toMatchObject({ action: "REFUSE" });
    expect(slipPlan({ type: "application/zip", size: 10, name: "x.zip" })).toMatchObject({ action: "REFUSE", error: expect.stringMatching(/JPG or PNG/) });
    expect(slipPlan({ type: "application/pdf", size: 5 * MB + 1, name: "x.pdf" })).toMatchObject({ action: "REFUSE", error: expect.stringMatching(/5 MB/) });
  });

  it("extension and fingerprint", async () => {
    expect([slipExtension("application/pdf"), slipExtension("image/png"), slipExtension("image/jpeg")]).toEqual(["pdf", "png", "jpg"]);
    const bytes = new TextEncoder().encode("slip");
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
