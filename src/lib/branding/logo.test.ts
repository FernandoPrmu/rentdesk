import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { companyInitials, LOGO_MAX_BYTES, sniffLogoType, svgSafetyProblem, validateLogo } from "./logo";
import { processLogo } from "./logo-image";

const text = (s: string) => new TextEncoder().encode(s);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0a7"/></svg>';

function image(format: "png" | "jpeg", width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } })[format]().toBuffer();
}

describe("sniffLogoType", () => {
  it("detects PNG, JPEG and SVG by content, not by name", async () => {
    expect(sniffLogoType(await image("png", 4, 4))).toBe("png");
    expect(sniffLogoType(await image("jpeg", 4, 4))).toBe("jpeg");
    expect(sniffLogoType(text(SVG))).toBe("svg");
    const BOM = String.fromCharCode(0xfeff);
    expect(sniffLogoType(text(`${BOM}<?xml version="1.0"?>\n<!-- logo -->\n${SVG}`))).toBe("svg");
  });

  it("rejects other files", () => {
    expect(sniffLogoType(text("%PDF-1.4"))).toBeNull();
    expect(sniffLogoType(text("GIF89a"))).toBeNull();
    expect(sniffLogoType(text("<html><svg></svg></html>"))).toBeNull();
    expect(sniffLogoType(text('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffLogoType(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("svgSafetyProblem", () => {
  it("accepts a plain SVG with internal references and embedded images", () => {
    expect(svgSafetyProblem(SVG)).toBeNull();
    expect(svgSafetyProblem('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>')).toBeNull();
    expect(svgSafetyProblem('<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')).toBeNull();
  });

  it.each([
    ['<svg><script>alert(1)</script></svg>', "scripts"],
    ['<svg onload="alert(1)"></svg>', "event handlers"],
    ['<svg><foreignObject><div/></foreignObject></svg>', "embedded content"],
    ['<svg><a href="javascript:alert(1)"/></svg>', "JavaScript links"],
    ['<svg><image href="https://evil.example/x.png"/></svg>', "links to outside files"],
    ['<svg><image xlink:href="file:///etc/passwd"/></svg>', "links to outside files"],
    ["<svg><style>rect{fill:url(http://evil.example/a)}</style></svg>", "links to outside files"],
    ["<svg><style>@import url(#a);</style></svg>", "CSS imports"],
    ['<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>', "links to outside files"],
  ])("rejects %s", (svg, problem) => {
    expect(svgSafetyProblem(svg)).toBe(problem);
  });
});

describe("validateLogo", () => {
  it("enforces the size limit", () => {
    expect(validateLogo(new Uint8Array(0))).toEqual({ ok: false, error: "The file is empty." });
    const big = new Uint8Array(LOGO_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateLogo(big)).toMatchObject({ ok: false, error: "The logo must be 2 MB or smaller." });
  });

  it("explains why an unsafe SVG is refused", () => {
    const r = validateLogo(text('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("scripts");
  });
});

describe("processLogo", () => {
  it("shrinks a large PNG or JPEG to fit 512 px and outputs PNG", async () => {
    for (const format of ["png", "jpeg"] as const) {
      const r = await processLogo(await image(format, 1600, 800));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([r.width, r.height]).toEqual([512, 256]);
      expect(sniffLogoType(r.png)).toBe("png");
    }
  });

  it("does not enlarge small images", async () => {
    const r = await processLogo(await image("png", 120, 60));
    expect(r.ok && [r.width, r.height]).toEqual([120, 60]);
  });

  it("rasterises an SVG to PNG", async () => {
    const r = await processLogo(text(SVG));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sniffLogoType(r.png)).toBe("png");
    expect(r.width).toBe(512);
    expect(new TextDecoder().decode(r.png)).not.toContain("<svg");
  });

  it("refuses a corrupt image whose magic bytes look right", async () => {
    const r = await processLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    expect(r).toEqual({ ok: false, error: "This image could not be read. Try another file." });
  });
});

describe("companyInitials", () => {
  it("makes a short badge from the company name", () => {
    expect(companyInitials("Ceylon Office Machines")).toBe("CO");
    expect(companyInitials("Lanka Copy Solutions (Pvt) Ltd")).toBe("LC");
    expect(companyInitials("Xerox")).toBe("XE");
    expect(companyInitials("  ")).toBe("?");
  });
});
