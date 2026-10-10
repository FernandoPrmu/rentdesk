"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { describeCounts } from "@/lib/cron/daily";
import { runDailyJobNow } from "@/lib/cron/server";

/** Admin: run the daily job now (same code as Vercel Cron, real time only). */
export async function runDailyJobAction(): Promise<ActionResult<{ status: string; summary: string }>> {
  const actor = await currentActor("ADMIN");
  try {
    const result = await runDailyJobNow({ now: new Date(), trigger: "ADMIN", triggeredBy: actor.id });
    refresh();
    if (result.status === "SKIPPED") return fail("The daily job is already running. Try again in a few minutes.");
    return ok({ status: result.status, summary: describeCounts(result.counts) });
  } catch (error) {
    console.error("[cron] admin run:", error);
    return fail("The daily job could not run. Please try again.");
  }
}
