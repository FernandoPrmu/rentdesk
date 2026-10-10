"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import type { ManualPaymentInput, RefundInput, VerifyInput } from "@/lib/payments/schemas";
import { reallocateOwnerPayment, recordManualPayment, refundCredit, reverseOwnerPayment, verifySlip } from "@/lib/payments/service";

/**
 * The owner's payment actions (PAY-05, PAY-07, PAY-12, TKT-10, 11.5). Each one
 * checks the owner again, parses its input, and goes through a transition
 * function whose rpc checks everything once more under the row locks.
 */

function done<T extends ActionResult<unknown>>(result: T): T {
  if (result.ok) refresh();
  return result;
}

export async function verifyPaymentAction(input: VerifyInput): Promise<ActionResult<{ status: string; receiptNo: string | null }>> {
  const actor = await currentActor("OWNER");
  return done(await verifySlip(actor, input));
}

export async function recordPaymentAction(input: ManualPaymentInput): Promise<ActionResult<{ paymentId: string; receiptNo: string; replayed: boolean }>> {
  const actor = await currentActor("OWNER");
  return done(await recordManualPayment(actor, input));
}

export async function reversePaymentAction(input: { paymentId: string; reason: string }): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  return done(await reverseOwnerPayment(actor, input));
}

export async function reallocatePaymentAction(input: { paymentId: string; invoiceIds: string[]; reason: string }): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  return done(await reallocateOwnerPayment(actor, input));
}

export async function refundCreditAction(input: RefundInput): Promise<ActionResult<{ leftCents: number }>> {
  const actor = await currentActor("OWNER");
  return done(await refundCredit(actor, input));
}
