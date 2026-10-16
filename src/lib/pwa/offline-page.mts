/**
 * Finds the prerendered /offline page after `next build`, for serwist.config.mjs (decision 88).
 * Node only (reads the build output); the service worker uses cache-policy.mts instead.
 * `.mts` with only erasable types: Node loads it straight from serwist.config.mjs.
 *
 * Where Next writes the HTML depends on the build:
 * - plain `next build`: `<distDir>/server/app/offline.html`
 * - with a deployment adapter (Vercel sets NEXT_ADAPTER_PATH): the response cache layout,
 *   `<distDir>/server/route-cache/APP_PAGE/<sha256 of the source route>/$/offline.html`
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { OFFLINE_URL } from "./cache-policy.mts";

/** Every place the prerendered offline page can be, that exists. */
export function offlineHtmlCandidates(distDir: string): string[] {
  const server = path.join(distDir, "server");
  const found: string[] = [];
  const plain = path.join(server, "app", `${OFFLINE_URL.slice(1)}.html`);
  if (existsSync(plain)) found.push(plain);
  const routeCache = path.join(server, "route-cache", "APP_PAGE");
  if (existsSync(routeCache)) {
    for (const source of readdirSync(routeCache)) {
      const file = path.join(routeCache, source, "$", `${OFFLINE_URL.slice(1)}.html`);
      if (existsSync(file)) found.push(file);
    }
  }
  return found;
}

/** The one prerendered offline page; throws (failing the build) if there is none or more than one. */
export function findOfflineHtml(distDir: string): string {
  const found = offlineHtmlCandidates(distDir);
  if (found.length === 1) return found[0];
  throw new Error(
    found.length === 0
      ? `The prerendered ${OFFLINE_URL} page was not found under ${path.join(distDir, "server")}. Run \`next build\` first.`
      : `More than one prerendered ${OFFLINE_URL} page: ${found.join(", ")}`,
  );
}

/** The precache entry for the offline page: its URL, versioned by the HTML's content. */
export function offlinePrecacheEntry(html: string): { url: string; revision: string } {
  return { url: OFFLINE_URL, revision: createHash("sha256").update(html).digest("hex").slice(0, 32) };
}
