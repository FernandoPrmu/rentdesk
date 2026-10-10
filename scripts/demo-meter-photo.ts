import sharp from "sharp";

/**
 * Seed only: a demo meter photo that looks like a copier's counter screen and
 * shows the seeded reading(s) clearly, so the owner's review and zoom can be
 * tried with the demo data (a plain black picture showed nothing). Drawn as SVG
 * and encoded as JPEG with sharp; slight vignette and grain so it is not flat.
 */

export interface DemoMeter {
  machine: string;
  serialNo: string;
  bw: number;
  colour: number | null;
}

const WIDTH = 1280;
const HEIGHT = 960;

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
/** As a copier shows it: digits only, leading zeros (13400 -> "0013400"). */
const counter = (n: number) => n.toString().padStart(7, "0");

function svg(m: DemoMeter): string {
  const rows = [{ label: "Black & White total", value: m.bw }, ...(m.colour === null ? [] : [{ label: "Full colour total", value: m.colour }])];
  const rowHeight = 190;
  const top = m.colour === null ? 400 : 330;
  const grain = Array.from({ length: 900 }, (_, i) => {
    const x = (i * 7919) % WIDTH;
    const y = (i * 104729) % HEIGHT;
    const o = ((i * 31) % 9) / 100;
    return `<rect x="${x}" y="${y}" width="3" height="3" fill="#000" opacity="${o}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <radialGradient id="v" cx="50%" cy="45%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/></radialGradient>
    <linearGradient id="lcd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe3c9"/><stop offset="1" stop-color="#a9c7a2"/></linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#3c4148"/>
  <rect x="80" y="70" width="${WIDTH - 160}" height="${HEIGHT - 140}" rx="28" fill="#23272c"/>
  <rect x="130" y="120" width="${WIDTH - 260}" height="${HEIGHT - 240}" rx="12" fill="url(#lcd)"/>
  <text x="170" y="200" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#1d2a1b">Counter</text>
  <text x="170" y="255" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#2f3f2c">${escapeXml(m.machine)}   S/N ${escapeXml(m.serialNo)}</text>
  ${rows
    .map(
      (r, i) => `
  <text x="170" y="${top + i * rowHeight}" font-family="Arial, Helvetica, sans-serif" font-size="36" fill="#2f3f2c">${escapeXml(r.label)}</text>
  <text x="${WIDTH - 170}" y="${top + i * rowHeight + 95}" text-anchor="end" font-family="Consolas, 'Courier New', monospace" font-size="120" font-weight="bold" fill="#0f1a0d">${counter(r.value)}</text>`,
    )
    .join("")}
  ${grain}
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#v)"/>
</svg>`;
}

export async function demoMeterPhoto(meter: DemoMeter): Promise<Buffer> {
  return sharp(Buffer.from(svg(meter))).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/** Seed only: a simple square logo with the company's initials (PNG, 512 px). */
export async function demoLogo(initials: string, colour = "#0f4c81"): Promise<Buffer> {
  const svgLogo = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${colour}"/>
  <text x="256" y="318" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="190" font-weight="bold" fill="#fff">${escapeXml(initials)}</text>
</svg>`;
  return sharp(Buffer.from(svgLogo)).png().toBuffer();
}
