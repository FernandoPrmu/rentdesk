"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { type DisputeInput, raiseCustomerDispute } from "@/lib/disputes/service";

/** 11.4 / CP-06: the customer disputes a bill (once), with an optional photo or PDF already in their folder. */
export async function raiseDisputeAction(input: DisputeInput): Promise<ActionResult<{ ticketId: string; replayed: boolean }>> {
  const actor = await currentActor("CUSTOMER");
  const result = await raiseCustomerDispute(actor, input);
  if (result.ok) refresh();
  return result;
}
