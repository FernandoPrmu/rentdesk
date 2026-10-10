"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import type { CustomerPaymentInput } from "@/lib/payments/schemas";
import { type SubmitResult, submitCustomerPayment } from "@/lib/payments/service";

/**
 * CP-04 / PAY-02: the customer's slip for one or more bills. The file is already
 * in the customer's private folder (uploaded by the browser); the server checks
 * it, warns about a possible duplicate, and the key makes a retry or a double tap
 * return the first payment.
 */
export async function submitPaymentAction(input: CustomerPaymentInput): Promise<ActionResult<SubmitResult>> {
  const actor = await currentActor("CUSTOMER");
  const result = await submitCustomerPayment(actor, input);
  if (result.ok && !("needsConfirm" in result.data)) refresh();
  return result;
}
