import { isAuthorizedCronRequest } from "@/lib/cron/auth";

/**
 * Daily scheduler entry point, called once a day by Vercel Cron (see vercel.json).
 * Stub for now: ticket creation, reminders, escalation and photo clean-up arrive
 * with the ticket state machine (TKT-01, TKT-05, TKT-07).
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({ ok: true, ranAt: new Date().toISOString(), jobs: [] });
}
