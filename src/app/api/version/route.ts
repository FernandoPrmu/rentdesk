import { connection } from "next/server";

import { BUILD_ID } from "@/lib/pwa/version";

/**
 * The build that serves this request (decision 89). Public and data-free: an open
 * page compares it with the build it runs and offers "New version available".
 */
export async function GET() {
  await connection();
  return Response.json({ buildId: BUILD_ID }, { headers: { "Cache-Control": "no-store" } });
}
