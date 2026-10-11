"use server";

import { type ActionResult, fail } from "@/lib/action-result";
import { uuidSchema } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { type OwnerStepForm, ownerServiceAction } from "@/lib/service/service";
import type { ServiceStatus } from "@/lib/service/states";

/** SRV-03, SRV-04, SRV-07: the owner's steps on a service request. The rpc function checks everything again. */
export async function ownerServiceStepAction(requestId: string, input: OwnerStepForm): Promise<ActionResult<{ status: ServiceStatus }>> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(requestId).success) return fail("This request was not found.");
  return ownerServiceAction(actor, requestId, input);
}
