/**
 * New-version detection (decision 89), a free stand-in for Vercel Skew Protection.
 * The build ID is inlined into both the page and /api/version at build time; when the
 * server answers with another ID, a new deployment is live and this page's code (and
 * its Server Action IDs) are out of date.
 */

/** This build's ID, inlined by next.config.ts. "dev" outside a deployment build. */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

export const VERSION_PATH = "/api/version";

/** How often an open page asks, besides on focus and when it becomes visible. */
export const VERSION_CHECK_MS = 15 * 60 * 1000;

/** Whether the served build differs from the one this page runs. Unknown answers never show the banner. */
export function isNewVersion(current: string, served: unknown): boolean {
  if (typeof served !== "string" || !served || served === "dev" || !current || current === "dev") return false;
  return served !== current;
}

/** Reads the served build ID from the /api/version body; null when it cannot be read. */
export function parseVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { buildId?: unknown }).buildId;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}

/** Build ID from the environment of the build (Vercel deployment, commit, or a local fallback). */
export function resolveBuildId(env: Record<string, string | undefined>, fallback: () => string): string {
  return env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || env.RENTDESK_BUILD_ID || fallback();
}
