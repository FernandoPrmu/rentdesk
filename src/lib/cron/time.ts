/**
 * Testing time for the daily job: outside production a request may say which
 * "now" to use, so tests and `npm run cron:run --now=...` can simulate dates.
 *
 * It can never be used in production: Next.js replaces `process.env.NODE_ENV`
 * with "production" when it builds the app, so in every built deployment
 * (production, preview, `next start`) the check below is false at build time and
 * the override is ignored. Vercel's own production environment is refused as
 * well. Only `next dev`, unit tests and DB tests (which pass `now` directly)
 * can simulate time.
 */

/** Header (or `?now=` query parameter) with an ISO date-time, e.g. 2026-11-01T01:00:00+05:30. */
export const NOW_HEADER = "x-rentdesk-now";

export function timeOverrideAllowed(nodeEnv: string | undefined = process.env.NODE_ENV, vercelEnv: string | undefined = process.env.VERCEL_ENV): boolean {
  return nodeEnv !== "production" && vercelEnv !== "production";
}

export type CronNow = { ok: true; now: Date; simulated: boolean } | { ok: false; error: string };

/** The "now" for a run: the real clock, or a valid override where allowed. */
export function cronNow(request: Request, allowed: boolean = timeOverrideAllowed(), realNow: Date = new Date()): CronNow {
  const requested = request.headers.get(NOW_HEADER) ?? new URL(request.url).searchParams.get("now");
  if (!requested) return { ok: true, now: realNow, simulated: false };
  if (!allowed) return { ok: false, error: "Time override is not available in production" };
  // A full date-time with a zone, so the simulated moment is never ambiguous.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(requested)) {
    return { ok: false, error: "Use an ISO date-time with a time zone, e.g. 2026-11-01T01:00:00+05:30" };
  }
  const now = new Date(requested);
  if (Number.isNaN(now.getTime())) return { ok: false, error: "Invalid date-time" };
  return { ok: true, now, simulated: true };
}
