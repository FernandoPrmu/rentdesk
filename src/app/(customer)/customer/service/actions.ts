"use server";

import { type ActionResult, fail } from "@/lib/action-result";
import { uuidSchema } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import type { RaiseInput } from "@/lib/service/schemas";
import { type CustomerStepForm, customerServiceAction, raiseServiceRequest, rateService } from "@/lib/service/service";
import type { ServiceStatus } from "@/lib/service/states";

/** CP-07: the customer raises, confirms, reopens, cancels and rates service requests. The rpc functions check everything again. */

export async function raiseServiceAction(input: RaiseInput): Promise<ActionResult<{ requestId: string; replayed: boolean }>> {
  const actor = await currentActor("CUSTOMER");
  // No refresh: the form shows its own success screen, which links to the request.
  return raiseServiceRequest(actor, input);
}

export async function customerServiceStepAction(requestId: string, input: CustomerStepForm): Promise<ActionResult<{ status: ServiceStatus }>> {
  const actor = await currentActor("CUSTOMER");
  if (!uuidSchema.safeParse(requestId).success) return fail("This request was not found.");
  return customerServiceAction(actor, requestId, input);
}

export async function rateServiceAction(requestId: string, input: { rating: number; comment?: string }): Promise<ActionResult> {
  const actor = await currentActor("CUSTOMER");
  if (!uuidSchema.safeParse(requestId).success) return fail("This request was not found.");
  return rateService(actor, requestId, input);
}
