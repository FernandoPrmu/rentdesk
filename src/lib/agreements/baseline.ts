import "server-only";

import { z } from "zod";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadAgreementCounters } from "@/lib/billing/context";
import { carriedCopies, previousReading } from "@/lib/billing/usage";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { formatCount } from "@/lib/format";
import { parseReading } from "@/lib/meter/readings";
import { customer, notificationsFor } from "@/lib/notifications/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { englishOnly } from "@/lib/text/english";
import { RpcError } from "@/lib/tickets/transitions";

/**
 * A new meter baseline after the meter was replaced or reset (spec 6.4, 11.2, 11.8;
 * decision 51). The owner gives the new starting reading of each counter that
 * changed and, when known, the old meter's last reading: the copies printed on it
 * since the last reading are billed with the next reading (carried copies).
 * Blocked while a reading waits for review (it was calculated from the old meter).
 * One audited rpc writes the baseline, the ticket event and the customer's notice.
 */

export interface BaselineView {
  agreementId: string;
  customerId: string;
  machine: string;
  machineType: "MONO" | "COLOUR";
  live: boolean;
  counters: { counter: "BW" | "COLOUR"; previous: number; carried: number }[];
  /** Why a baseline cannot be recorded now, or null. */
  blocked: string | null;
}

export async function getBaselineView(owner: CurrentUser, agreementId: string): Promise<BaselineView | null> {
  const admin = createAdminClient();
  const { data: a } = await admin
    .from("rental_agreements")
    .select("id, owner_id, customer_id, status, machine:machines!rental_agreements_machine_fkey(brand, model, serial_no)")
    .eq("id", agreementId)
    .maybeSingle();
  if (!a || a.owner_id !== owner.id) return null;
  const [{ machineType, counters }, { count: pending }] = await Promise.all([
    loadAgreementCounters(admin, a.id),
    admin.from("billing_cycle_tickets").select("id", { count: "exact", head: true }).eq("agreement_id", a.id).eq("status", "PENDING_OWNER_REVIEW"),
  ]);
  const live = a.status === "ACTIVE";
  return {
    agreementId: a.id,
    customerId: a.customer_id,
    machine: `${a.machine.brand} ${a.machine.model} (${a.machine.serial_no})`,
    machineType,
    live,
    counters: (["BW", "COLOUR"] as const)
      .filter((c) => counters[c])
      .map((c) => ({ counter: c, previous: previousReading(counters[c]!.known).value, carried: carriedCopies(counters[c]!.known) })),
    blocked: !live
      ? "This agreement has ended."
      : (pending ?? 0) > 0
        ? "A meter reading or estimate is waiting for your review. Confirm or reject it first: it was calculated from the old meter."
        : null,
  };
}

export const baselineInputSchema = z.object({
  agreementId: z.uuid(),
  reason: z.string().trim().min(3, "Write what happened (the customer sees it).").max(500).refine(...englishOnly),
  bw: z.string().max(20).default(""),
  colour: z.string().max(20).default(""),
  oldBw: z.string().max(20).default(""),
  oldColour: z.string().max(20).default(""),
});
export type BaselineInput = z.input<typeof baselineInputSchema>;

export async function recordBaseline(owner: CurrentUser, input: BaselineInput): Promise<ActionResult & { fieldErrors?: Record<string, string> }> {
  const parsed = baselineInputSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, { [String(parsed.error.issues[0].path[0])]: parsed.error.issues[0].message });
  const i = parsed.data;
  try {
    const view = await getBaselineView(owner, i.agreementId);
    if (!view) return fail("This agreement was not found.");
    if (view.blocked) return fail(view.blocked);

    const errors: Record<string, string> = {};
    const counters: { counter_type: "BW" | "COLOUR"; value: number; old_meter_reading: number | null }[] = [];
    const changes: string[] = [];
    for (const c of view.counters) {
      const [newKey, oldKey] = c.counter === "BW" ? (["bw", "oldBw"] as const) : (["colour", "oldColour"] as const);
      const label = c.counter === "BW" ? "B&W" : "colour";
      if (i[newKey].trim() === "") {
        if (i[oldKey].trim() !== "") errors[newKey] = `Type the new meter's ${label} starting reading`;
        continue;
      }
      const value = parseReading(i[newKey], label);
      if (!value.ok) {
        errors[newKey] = value.error;
        continue;
      }
      let old: number | null = null;
      if (i[oldKey].trim() !== "") {
        const parsedOld = parseReading(i[oldKey], `old ${label}`);
        if (!parsedOld.ok) errors[oldKey] = parsedOld.error;
        else if (parsedOld.value < c.previous) errors[oldKey] = `Lower than the last ${label} reading (${formatCount(c.previous)})`;
        else old = parsedOld.value;
      }
      counters.push({ counter_type: c.counter, value: value.value, old_meter_reading: old });
      changes.push(`${c.counter === "BW" ? "B&W" : "Colour"} ${formatCount(value.value)}`);
    }
    if (Object.keys(errors).length > 0) return fail("Please check the readings.", errors);
    if (counters.length === 0) return fail("Type the new starting reading of the meter that changed.", { bw: "Type the new starting reading" });

    const admin = createAdminClient();
    await supabaseRpc(admin)("rpc_record_meter_baseline", {
      p_agreement_id: view.agreementId,
      p_actor_id: owner.id,
      p_reason: i.reason,
      p_counters: counters,
      p_notifications: notificationsFor("meter.baseline", [customer(view.customerId)], { machine: view.machine, changes: changes.join(", "), reason: i.reason }, { link: "/customer/machines" }),
    });
    return ok(undefined);
  } catch (error) {
    if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, "baseline"));
    console.error("[baseline]", error);
    return fail("Something went wrong. Please try again.");
  }
}
