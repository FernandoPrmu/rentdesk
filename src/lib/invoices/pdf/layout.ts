/**
 * Letterhead layout (BRD-05): where the invoice data goes on the owner's
 * letterhead, stored in owner_company_profiles.letterhead_layout as percentages
 * of the A4 page (origin top-left, like the preview on screen), converted to
 * PDF points (origin bottom-left) when rendering. Pure; only relative imports.
 */

/** A4 in PDF points (1/72 inch): 210 × 297 mm. */
export const A4 = { width: 595.28, height: 841.89 } as const;

/** Height ÷ width of A4 (√2). */
export const A4_RATIO = A4.height / A4.width;

/** A file within 3 % of the A4 proportions is accepted without a warning. */
export const A4_TOLERANCE = 0.03;

export const LAYOUT_PRESETS = ["HEADER_ONLY", "HEADER_FOOTER", "FULL_PAGE"] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];
export type LayoutChoice = LayoutPreset | "CUSTOM";

/** Percent of the page: left, top, width, height. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LetterheadLayout {
  preset: LayoutChoice;
  area: Area;
}

export const PRESET_LABEL: Record<LayoutPreset, string> = {
  HEADER_ONLY: "Header only",
  HEADER_FOOTER: "Header and footer",
  FULL_PAGE: "Full-page design",
};

export const PRESET_HINT: Record<LayoutPreset, string> = {
  HEADER_ONLY: "Your design is at the top of the page. Invoice details fill the rest.",
  HEADER_FOOTER: "Your design is at the top and the bottom. Invoice details go in between.",
  FULL_PAGE: "Your design covers the whole page. Invoice details sit in a box in the middle.",
};

/** Data areas of the presets (percent of the page). */
export const PRESET_AREAS: Record<LayoutPreset, Area> = {
  HEADER_ONLY: { x: 7, y: 20, w: 86, h: 76 },
  HEADER_FOOTER: { x: 7, y: 20, w: 86, h: 64 },
  FULL_PAGE: { x: 12, y: 24, w: 76, h: 56 },
};

/** Smallest data area the invoice still fits in (with the font scaled down). */
export const MIN_AREA = { w: 50, h: 40 } as const;

export const DEFAULT_LAYOUT: LetterheadLayout = { preset: "HEADER_ONLY", area: PRESET_AREAS.HEADER_ONLY };

export function presetLayout(preset: LayoutPreset): LetterheadLayout {
  return { preset, area: { ...PRESET_AREAS[preset] } };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Keeps an area on the page and at least the minimum size, rounded to 0.1 %:
 * the size is clamped first, then the position so the area stays inside.
 */
export function clampArea(area: Area): Area {
  const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  const w = Math.min(100, Math.max(MIN_AREA.w, finite(area.w, MIN_AREA.w)));
  const h = Math.min(100, Math.max(MIN_AREA.h, finite(area.h, MIN_AREA.h)));
  const x = Math.min(100 - w, Math.max(0, finite(area.x, 0)));
  const y = Math.min(100 - h, Math.max(0, finite(area.y, 0)));
  return { x: round1(x), y: round1(y), w: round1(w), h: round1(h) };
}

/** Points on the page for an area: PDF origin is the bottom-left corner. */
export function areaToPoints(area: Area, page: { width: number; height: number } = A4) {
  const width = (area.w / 100) * page.width;
  const height = (area.h / 100) * page.height;
  const x = (area.x / 100) * page.width;
  const y = page.height - ((area.y + area.h) / 100) * page.height;
  return { x, y, width, height };
}

/** A stored layout (jsonb, possibly empty or from an older version) → a valid layout. */
export function parseLayout(value: unknown): LetterheadLayout {
  if (typeof value !== "object" || value === null) return DEFAULT_LAYOUT;
  const v = value as { preset?: unknown; area?: unknown };
  const preset: LayoutChoice =
    v.preset === "CUSTOM" || (LAYOUT_PRESETS as readonly unknown[]).includes(v.preset) ? (v.preset as LayoutChoice) : "HEADER_ONLY";
  const a = v.area as Partial<Area> | undefined;
  if (!a || typeof a !== "object") return preset === "CUSTOM" ? DEFAULT_LAYOUT : presetLayout(preset);
  return { preset, area: clampArea({ x: Number(a.x), y: Number(a.y), w: Number(a.w), h: Number(a.h) }) };
}

/** Whether a page or image of this size has A4 proportions (portrait). */
export function a4Check(width: number, height: number): { ok: boolean; landscape: boolean; ratio: number } {
  const ratio = height / width;
  return { ok: Math.abs(ratio - A4_RATIO) / A4_RATIO <= A4_TOLERANCE, landscape: width > height, ratio };
}

export type Corner = "nw" | "ne" | "sw" | "se";

/** Drags the whole area by (dx, dy) percent; it stays on the page. */
export function moveArea(start: Area, dx: number, dy: number): Area {
  return clampArea({ ...start, x: start.x + dx, y: start.y + dy });
}

/**
 * Drags one corner by (dx, dy) percent. The opposite corner stays put; the area
 * never gets smaller than the minimum or leaves the page.
 */
export function resizeArea(start: Area, corner: Corner, dx: number, dy: number): Area {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (corner === "nw" || corner === "sw") left = Math.min(Math.max(0, left + dx), right - MIN_AREA.w);
  else right = Math.max(Math.min(100, right + dx), left + MIN_AREA.w);
  if (corner === "nw" || corner === "ne") top = Math.min(Math.max(0, top + dy), bottom - MIN_AREA.h);
  else bottom = Math.max(Math.min(100, bottom + dy), top + MIN_AREA.h);
  return clampArea({ x: left, y: top, w: right - left, h: bottom - top });
}
