"use server";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { type DisputeInput, raiseCustomerDispute } from "@/lib/disputes/service";

/** 11.4 / CP-06: the customer disputes a bill (once), with an optional photo or PDF already in their folder. */
export async function raiseDisputeAction(input: DisputeInput): Promise<ActionResult<{ ticketId: string; replayed: boolean }>> {
  const actor = await currentActor("CUSTOMER");
  // No refresh: this page would swap the success screen for "already disputed"; the ticket page it links to loads fresh.
  return raiseCustomerDispute(actor, input);
}
