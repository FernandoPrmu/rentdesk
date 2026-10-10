import { describe, expect, it } from "vitest";

import {
  A4,
  a4Check,
  areaToPoints,
  clampArea,
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  MIN_AREA,
  moveArea,
  parseLayout,
  PRESET_AREAS,
  presetLayout,
  resizeArea,
} from "./layout";

describe("letterhead layout: percent of the page → PDF points", () => {
  it("the whole page is the whole A4 page", () => {
    expect(areaToPoints({ x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 0, y: 0, width: A4.width, height: A4.height });
  });

  it("flips the vertical axis: percentages start at the top, PDF points at the bottom", () => {
    const top = areaToPoints({ x: 0, y: 0, w: 100, h: 10 });
    expect(top.y).toBeCloseTo(A4.height * 0.9, 6);
    expect(top.height).toBeCloseTo(A4.height * 0.1, 6);
    const bottom = areaToPoints({ x: 0, y: 90, w: 100, h: 10 });
    expect(bottom.y).toBeCloseTo(0, 6);
  });

  it("converts a preset exactly", () => {
    const p = areaToPoints(PRESET_AREAS.HEADER_ONLY); // x 7, y 20, w 86, h 76
    expect(p.x).toBeCloseTo(0.07 * 595.28, 6);
    expect(p.width).toBeCloseTo(0.86 * 595.28, 6);
    expect(p.height).toBeCloseTo(0.76 * 841.89, 6);
    expect(p.y).toBeCloseTo(841.89 - 0.96 * 841.89, 6);
  });

  it("works for any page size", () => {
    expect(areaToPoints({ x: 50, y: 50, w: 50, h: 50 }, { width: 200, height: 100 })).toEqual({ x: 100, y: 0, width: 100, height: 50 });
  });
});

describe("presets", () => {
  it("every preset lies on the page, above the minimum size, and round-trips through parseLayout", () => {
    for (const p of LAYOUT_PRESETS) {
      const a = PRESET_AREAS[p];
      expect(a.x + a.w, p).toBeLessThanOrEqual(100);
      expect(a.y + a.h, p).toBeLessThanOrEqual(100);
      expect(a.w, p).toBeGreaterThanOrEqual(MIN_AREA.w);
      expect(a.h, p).toBeGreaterThanOrEqual(MIN_AREA.h);
      expect(clampArea(a), p).toEqual(a);
      expect(parseLayout(presetLayout(p)), p).toEqual(presetLayout(p));
    }
  });

  it("header and footer leaves room at the bottom; full page is a box in the middle", () => {
    const hf = PRESET_AREAS.HEADER_FOOTER;
    const ho = PRESET_AREAS.HEADER_ONLY;
    expect(hf.y + hf.h).toBeLessThan(ho.y + ho.h);
    const fp = PRESET_AREAS.FULL_PAGE;
    expect(fp.x).toBeGreaterThan(ho.x);
    expect(100 - (fp.y + fp.h)).toBeGreaterThan(10);
  });

  it("an empty or unknown stored layout becomes the default", () => {
    expect(parseLayout({})).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout({ preset: "default" })).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout({ preset: "FULL_PAGE" })).toEqual(presetLayout("FULL_PAGE"));
  });

  it("a stored custom area is kept inside the page", () => {
    expect(parseLayout({ preset: "CUSTOM", area: { x: 80, y: -5, w: 60, h: 200 } })).toEqual({ preset: "CUSTOM", area: { x: 40, y: 0, w: 60, h: 100 } });
    expect(parseLayout({ preset: "CUSTOM", area: { x: "a", y: 1, w: 70, h: 50 } }).area).toEqual({ x: 0, y: 1, w: 70, h: 50 });
  });
});

describe("dragging and resizing the data area", () => {
  const start = { x: 10, y: 20, w: 60, h: 50 };

  it("moves and stops at the page edges", () => {
    expect(moveArea(start, 5, -5)).toEqual({ x: 15, y: 15, w: 60, h: 50 });
    expect(moveArea(start, 100, 100)).toEqual({ x: 40, y: 50, w: 60, h: 50 });
    expect(moveArea(start, -100, -100)).toEqual({ x: 0, y: 0, w: 60, h: 50 });
  });

  it("resizes from each corner with the opposite corner fixed", () => {
    expect(resizeArea(start, "se", 10, 10)).toEqual({ x: 10, y: 20, w: 70, h: 60 });
    expect(resizeArea(start, "nw", -5, -5)).toEqual({ x: 5, y: 15, w: 65, h: 55 });
    expect(resizeArea(start, "ne", 5, 5)).toEqual({ x: 10, y: 25, w: 65, h: 45 });
    expect(resizeArea(start, "sw", 5, -5)).toEqual({ x: 15, y: 20, w: 55, h: 45 });
  });

  it("never goes below the minimum size or off the page", () => {
    expect(resizeArea(start, "nw", 40, 40)).toEqual({ x: 20, y: 30, w: MIN_AREA.w, h: MIN_AREA.h });
    expect(resizeArea(start, "se", -40, -40)).toEqual({ x: 10, y: 20, w: MIN_AREA.w, h: MIN_AREA.h });
    expect(resizeArea(start, "se", 100, 100)).toEqual({ x: 10, y: 20, w: 90, h: 80 });
    expect(resizeArea(start, "nw", -100, -100)).toEqual({ x: 0, y: 0, w: 70, h: 70 });
  });
});

describe("A4 proportions", () => {
  it("accepts A4 at any resolution, warns otherwise", () => {
    expect(a4Check(595.28, 841.89).ok).toBe(true);
    expect(a4Check(2480, 3508).ok).toBe(true);
    expect(a4Check(1240, 1754).ok).toBe(true);
    expect(a4Check(612, 792)).toMatchObject({ ok: false, landscape: false }); // US Letter
    expect(a4Check(841.89, 595.28)).toMatchObject({ ok: false, landscape: true });
  });
});
