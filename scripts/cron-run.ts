/**
 * npm run cron:run [-- --now=2026-11-01T01:00:00+05:30] [--url=http://localhost:3000]
 *
 * Calls /api/cron/daily on a running app (default: the dev server on
 * localhost:3000) with CRON_SECRET from .env.local, like Vercel Cron does, and
 * prints the result. --now simulates the date; the app honours it only outside
 * production (src/lib/cron/time.ts).
 */

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")] as const;
  }),
);

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (.env.local).");
  process.exit(1);
}

const base = (args.get("url") || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const headers: Record<string, string> = { authorization: `Bearer ${secret}`, "x-rentdesk-trigger": "LOCAL" };
const now = args.get("now");
if (now) headers["x-rentdesk-now"] = now;

const response = await fetch(`${base}/api/cron/daily`, { headers });
const body = await response.text();
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
if (!response.ok) process.exit(1);

export {};
