"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail } from "@/lib/action-result";
import { uuidSchema } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { resendInvoiceNotification } from "@/lib/invoices/resend";

/** 11.4: the owner sends a bill's notice to the customer again. */
export async function resendInvoiceAction(invoiceId: string): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(invoiceId).success) return fail("This invoice was not found.");
  const result = await resendInvoiceNotification(actor, invoiceId);
  if (result.ok) refresh();
  return result;
}
