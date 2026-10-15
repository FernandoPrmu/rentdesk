/**
 * Renders every RentDesk icon from one SVG design (CP-09, decision 90):
 *   public/icons/icon-{192,512}.png            rounded tile ("any")
 *   public/icons/icon-maskable-{192,512}.png   full-bleed, artwork inside the 80 % safe zone
 *   public/icons/icon-monochrome-512.png       white glyph on transparent
 *   public/icons/shortcut-*-96.png              manifest shortcuts
 *   src/app/apple-icon.png                      180 × 180, opaque (iOS rounds it itself)
 *   src/app/icon.svg                            favicon
 * Run: node scripts/make-icons.ts (outputs are committed; re-run after a design change).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

const BLUE = "#1e40af";
const NAVY = "#1e3a8a";
const SKY = "#dbeafe";
const ROOT = process.cwd();

/** The copier with a printed page, drawn in a 100 × 100 box. */
function glyph(mono = false): string {
  const body = mono ? "#fff" : SKY;
  const lid = "#fff";
  const slot = mono ? "#000" : NAVY;
  const line = mono ? "#000" : BLUE;
  const lamp = mono ? "#000" : "#22c55e";
  return `
    <rect x="24" y="24" width="52" height="11" rx="3" fill="${lid}"/>
    <rect x="18" y="37" width="64" height="30" rx="6" fill="${body}"/>
    <circle cx="72" cy="45" r="3" fill="${lamp}"/>
    <rect x="28" y="55" width="44" height="5" rx="2.5" fill="${slot}"/>
    <path d="M32 58h36v22a3 3 0 0 1-3 3H35a3 3 0 0 1-3-3z" fill="#fff" ${mono ? "" : `stroke="${NAVY}" stroke-width="1"`}/>
    <rect x="37" y="66" width="26" height="3" rx="1.5" fill="${line}"/>
    <rect x="37" y="73" width="18" height="3" rx="1.5" fill="${line}"/>`;
}

function tile({ rounded, scale }: { rounded: boolean; scale: number }): string {
  const offset = (100 - 100 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" ${rounded ? 'rx="22"' : ""} fill="${BLUE}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${glyph()}</g>
</svg>`;
}

function mono(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(6 6) scale(0.88)">${glyph(true)}</g></svg>`;
}

const SHORTCUTS: Record<string, string> = {
  // A bill: a page with lines.
  bills: `<path d="M30 18h28l14 14v48a4 4 0 0 1-4 4H30a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z" fill="#fff"/><rect x="34" y="44" width="30" height="5" rx="2.5" fill="${BLUE}"/><rect x="34" y="56" width="30" height="5" rx="2.5" fill="${BLUE}"/><rect x="34" y="68" width="20" height="5" rx="2.5" fill="${BLUE}"/>`,
  // Pay: a banknote.
  pay: `<rect x="16" y="32" width="68" height="38" rx="6" fill="#fff"/><circle cx="50" cy="51" r="10" fill="${BLUE}"/><circle cx="27" cy="51" r="3" fill="${BLUE}"/><circle cx="73" cy="51" r="3" fill="${BLUE}"/>`,
  // Service: a wrench.
  service: `<path d="M64 18a18 18 0 0 0-17 24L22 67a7 7 0 0 0 10 10l25-25a18 18 0 0 0 24-17l-10 10-11-3-3-11z" fill="#fff"/>`,
  // Approvals: a tick in a circle.
  approvals: `<circle cx="50" cy="50" r="32" fill="#fff"/><path d="M36 51l10 10 19-21" fill="none" stroke="${BLUE}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
};

function shortcut(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${BLUE}"/>${SHORTCUTS[name]}</svg>`;
}

async function png(svg: string, size: number, file: string, opaque = false) {
  let img = sharp(Buffer.from(svg), { density: 384 }).resize(size, size);
  if (opaque) img = img.flatten({ background: BLUE });
  await img.png({ compressionLevel: 9 }).toFile(file);
  console.log("wrote", file);
}

async function main() {
  const icons = join(ROOT, "public", "icons");
  mkdirSync(icons, { recursive: true });
  const any = tile({ rounded: true, scale: 1 });
  // Maskable: the platform crops to any shape inside the outer 10 %, so the artwork
  // is drawn at 72 % on a full-bleed background.
  const maskable = tile({ rounded: false, scale: 0.72 });
  const apple = tile({ rounded: false, scale: 0.86 });

  await png(any, 192, join(icons, "icon-192.png"));
  await png(any, 512, join(icons, "icon-512.png"));
  await png(maskable, 192, join(icons, "icon-maskable-192.png"), true);
  await png(maskable, 512, join(icons, "icon-maskable-512.png"), true);
  await png(mono(), 512, join(icons, "icon-monochrome-512.png"));
  for (const name of Object.keys(SHORTCUTS)) await png(shortcut(name), 96, join(icons, `shortcut-${name}-96.png`));
  await png(apple, 180, join(ROOT, "src", "app", "apple-icon.png"), true);
  writeFileSync(join(ROOT, "src", "app", "icon.svg"), any + "\n");
  console.log("wrote src/app/icon.svg");
}

void main();
