/**
 * What the service worker may keep (decision 88). Only static, public build files:
 * the hashed Next.js assets, the app icons and the offline page. Never a page, an
 * RSC payload, an API answer, a signed URL, a PDF, an image of a meter or a slip,
 * or anything from another origin. Used by src/app/sw.ts (runtime) and by
 * serwist.config.mjs (precache list), so only relative imports and no TS-only syntax.
 */

/** The one runtime cache the worker writes to. */
export const STATIC_CACHE = "rentdesk-static-v1";

/** Precache cache names start with this (Serwist's default prefix). */
export const PRECACHE_PREFIX = "serwist-precache";

/** The page shown when a page cannot load without a connection. */
export const OFFLINE_URL = "/offline";

/** Same-origin public files outside /_next/static that are safe to keep. */
const PUBLIC_FILES = new Set(["/manifest.webmanifest", "/icon.svg", "/apple-icon.png", "/favicon.ico"]);

/**
 * Whether a build file belongs in the precache list. Paths are as `serwist build`
 * globs them, relative to the project: `.next/static/...`, `public/...`,
 * `.next/server/app/...html`.
 */
export function isPrecacheable(path: string, offlineRefs?: ReadonlySet<string>): boolean {
  const p = path.replace(/\\/g, "/");
  if (p.endsWith(".map")) return false;
  if (p.startsWith(".next/static/")) {
    // Install stays small on a poor connection: the stylesheets and what the offline
    // page loads. Every other chunk is cached the first time a page uses it.
    if (!offlineRefs) return true;
    return p.endsWith(".css") || offlineRefs.has(`/_next/${p.slice(".next/".length)}`);
  }
  if (p.startsWith("public/icons/")) return true;
  return p === ".next/server/app/offline.html";
}

/** The /_next/static files the prerendered offline page refers to. */
export function offlineAssetRefs(html: string): Set<string> {
  const refs = new Set<string>();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\s)\\]+/g)) refs.add(m[0].split("?")[0]);
  return refs;
}

/** Whether a request may be answered from (and stored in) the static runtime cache. */
export function isStaticAsset(url: URL, origin: string, method = "GET"): boolean {
  if (method !== "GET" || url.origin !== origin) return false;
  if (url.search && !url.pathname.startsWith("/_next/static/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return !url.pathname.endsWith(".map");
  if (url.pathname.startsWith("/icons/")) return true;
  return PUBLIC_FILES.has(url.pathname);
}

/** Caches the worker keeps on activation and the app keeps on sign-out; any other is deleted. */
export function isKeptCache(name: string): boolean {
  return name === STATIC_CACHE || name.startsWith(PRECACHE_PREFIX);
}
