"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail } from "@/lib/action-result";
import { uuidSchema } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { setInvoiceCredit } from "@/lib/invoices/credits";
import type { ReadingErrors } from "@/lib/meter/readings";
import { confirmReview, correctReview, enterReadingForCustomer, rejectReview } from "@/lib/meter/service";
import { type OwnerTicketAction, ownerTicketAction } from "@/lib/tickets/owner-actions";

/** Owner review of a meter reading or an estimate (INV-07..12, DEP-02). The rpc functions check everything again. */

function done<T extends ActionResult<unknown>>(result: T): T {
  if (result.ok) refresh();
  return result;
}

export async function confirmReviewAction(ticketId: string, rolloverConfirmed: boolean): Promise<ActionResult<{ invoiceNo: string }>> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(ticketId).success) return fail("This ticket was not found.");
  return done(await confirmReview(actor, ticketId, rolloverConfirmed));
}

export async function rejectReviewAction(ticketId: string, reason: string): Promise<ActionResult<{ final: boolean }>> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(ticketId).success) return fail("This ticket was not found.");
  if (!reason.trim()) return fail("Write a reason the customer will understand.", { reason: "A reason is required" });
  return done(await rejectReview(actor, ticketId, reason.trim()));
}

export async function correctReadingAction(
  ticketId: string,
  input: { bw: string; colour: string; note: string },
): Promise<ActionResult & { fieldErrors?: ReadingErrors & { note?: string } }> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(ticketId).success) return fail("This ticket was not found.");
  return done(await correctReview(actor, ticketId, { bw: input.bw, colour: input.colour }, input.note.trim()));
}

export async function setCreditAction(invoiceId: string, creditId: string, include: boolean): Promise<ActionResult<{ totalCents: number }>> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(invoiceId).success || !uuidSchema.safeParse(creditId).success) return fail("This credit was not found.");
  return done(await setInvoiceCredit(actor, invoiceId, creditId, include, null));
}

export async function manualEntryAction(input: {
  ticketId: string;
  idempotencyKey: string;
  bw: string;
  colour: string;
  note: string;
}): Promise<ActionResult & { fieldErrors?: Record<string, string> }> {
  const actor = await currentActor("OWNER");
  return done(await enterReadingForCustomer(actor, input));
}

/** TKT-10: cancel, reopen, ask for payment again, or a new due date, each with a reason where needed. */
export async function ticketAction(ticketId: string, input: OwnerTicketAction): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(ticketId).success) return fail("This ticket was not found.");
  return done(await ownerTicketAction(actor, ticketId, input));
}
