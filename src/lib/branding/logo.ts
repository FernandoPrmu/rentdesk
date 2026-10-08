/**
 * Logo validation (BRD-02). Pure: checks size and the real file type from its
 * magic bytes (never the browser's declared type), and refuses SVGs that could
 * run scripts or load outside resources. Accepted SVGs are rasterised to PNG
 * on the server (logo-image.ts), so a raw SVG is never stored or served.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** Longest side of the stored PNG, in pixels. */
export const LOGO_MAX_DIMENSION = 512;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg";

export type LogoType = "png" | "jpeg" | "svg";

export type LogoValidation =
  | { ok: true; type: LogoType }
  | { ok: false; error: string };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Text of an SVG file without BOM, XML declaration and leading comments. */
function svgBody(text: string): string {
  const BOM = 0xfeff;
  let s = (text.charCodeAt(0) === BOM ? text.slice(1) : text).trimStart();
  for (;;) {
    if (s.startsWith("<?xml")) {
      const end = s.indexOf("?>");
      if (end < 0) return s;
      s = s.slice(end + 2).trimStart();
    } else if (s.startsWith("<!--")) {
      const end = s.indexOf("-->");
      if (end < 0) return s;
      s = s.slice(end + 3).trimStart();
    } else {
      return s;
    }
  }
}

/** PNG, JPEG or SVG by content; null for anything else. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  if (startsWith(bytes, PNG_MAGIC)) return "png";
  if (startsWith(bytes, JPEG_MAGIC)) return "jpeg";
  // An SVG must be UTF-8 text whose first element is <svg (no DOCTYPE).
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  if (/^<svg[\s>]/i.test(svgBody(head))) return "svg";
  return null;
}

/**
 * Reasons an SVG is unsafe to process: scripts, event handlers, embedded HTML,
 * entity/DOCTYPE tricks, and any reference to an outside resource. Links inside the
 * file (`#id`) and embedded PNG/JPEG data are allowed.
 */
export function svgSafetyProblem(text: string): string | null {
  const checks: [RegExp, string][] = [
    [/<script[\s>/]/i, "scripts"],
    [/<!DOCTYPE|<!ENTITY/i, "DOCTYPE or entity declarations"],
    [/<(foreignObject|iframe|embed|object|audio|video)[\s>/]/i, "embedded content"],
    [/\son[a-z]+\s*=/i, "event handlers"],
    [/javascript:/i, "JavaScript links"],
    [/@import/i, "CSS imports"],
  ];
  for (const [pattern, what] of checks) {
    if (pattern.test(text)) return what;
  }
  // Every href / xlink:href / src must point inside the file or be embedded image data.
  for (const m of text.matchAll(/(?:^|[\s"'])(?:xlink:)?(?:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    if (!isAllowedReference(m[2])) return "links to outside files";
  }
  for (const m of text.matchAll(/url\(\s*(["']?)([\s\S]*?)\1\s*\)/gi)) {
    if (!isAllowedReference(m[2])) return "links to outside files";
  }
  return null;
}

function isAllowedReference(value: string): boolean {
  const v = value.trim();
  return v.startsWith("#") || /^data:image\/(png|jpeg);base64,/i.test(v);
}

export function validateLogo(bytes: Uint8Array): LogoValidation {
  if (bytes.length === 0) {
    return { ok: false, error: "The file is empty." };
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    return { ok: false, error: "The logo must be 2 MB or smaller." };
  }
  const type = sniffLogoType(bytes);
  if (!type) {
    return { ok: false, error: "Use a JPG, PNG or SVG image." };
  }
  if (type === "svg") {
    const problem = svgSafetyProblem(new TextDecoder().decode(bytes));
    if (problem) {
      return { ok: false, error: `This SVG cannot be used because it contains ${problem}. Try a PNG instead.` };
    }
  }
  return { ok: true, type };
}

/** Up to two initials for the fallback badge when there is no logo. */
export function companyInitials(name: string): string {
  const words = name
    .replace(/\((pvt|private)\)|\b(ltd|limited|pvt|plc|inc)\b\.?/gi, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const letters = words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 2).map((w) => w[0]).join("");
  return letters.toUpperCase() || "?";
}
