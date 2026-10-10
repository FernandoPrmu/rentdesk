import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { runDailyJobNow } from "@/lib/cron/server";
import { cronNow } from "@/lib/cron/time";

/**
 * Daily scheduler entry point, called once a day by Vercel Cron (vercel.json,
 * 19:00 UTC = 00:30-01:29 Asia/Colombo) and by `npm run cron:run`. Secured by
 * `Authorization: Bearer $CRON_SECRET`. Outside production only, the
 * `x-rentdesk-now` header or `?now=` simulates the date (src/lib/cron/time.ts).
 */

// Vercel Hobby allows 60 s; the job stops starting new work after 45 s.
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const time = cronNow(request);
  if (!time.ok) return Response.json({ error: time.error }, { status: 400 });

  const trigger = request.headers.get("x-rentdesk-trigger") === "LOCAL" ? "LOCAL" : "CRON";
  const result = await runDailyJobNow({ now: time.now, simulated: time.simulated, trigger });
  return Response.json(
    { ok: result.status !== "FAILED", ranAt: time.now.toISOString(), simulated: time.simulated, ...result },
    { status: result.status === "FAILED" ? 500 : 200 },
  );
}
