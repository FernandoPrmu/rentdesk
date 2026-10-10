import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { returnBlockedMessage } from "@/lib/agreements/blockers";
import { addDays, todayInColombo } from "@/lib/agreements/cycle-calendar";
import {
  type AssignmentInput,
  assignmentPayload,
  type ReturnInput,
  type SettlementInput,
  settlementPayload,
  type TermsEditInput,
  termsPayload,
} from "@/lib/agreements/schemas";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadReturnContext } from "@/lib/billing/context";
import { BillingError } from "@/lib/billing/errors";
import { buildReturnInvoice } from "@/lib/billing/return-invoice";
import { type DbError, dbErrorMessage } from "@/lib/db-errors";
import { getDepositState } from "@/lib/deposits/queries";
import { planSettlement } from "@/lib/deposits/settlement";
import { BRANDING_SNAPSHOT_COLUMNS, brandingSnapshot } from "@/lib/invoices/branding-snapshot";
import { onInvoiceChanged } from "@/lib/invoices/issued";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/db";

/**
 * Assign, return, reassign, edit terms, settle a deposit (MAC-02, MAC-04, AGR-01,
 * AGR-02, RET-01, DEP-01..04). Each is ONE atomic rpc call that checks the owner,
 * the tenant and the state again and writes the audit log. "Today" is always Sri
 * Lanka's date. Amounts come from the billing engine only; the database re-checks
 * them. Callers have already loaded the agreement as the owner (RLS).
 */

function message(error: DbError): string {
  return returnBlockedMessage(error.message) ?? dbErrorMessage(error, "agreements");
}

export async function assignMachine(
  actor: CurrentUser,
  machineId: string,
  input: AssignmentInput,
): Promise<ActionResult<{ agreementId: string }>> {
  const { data, error } = await createAdminClient().rpc("rpc_assign_machine", {
    p_actor_id: actor.id,
    p_machine_id: machineId,
    p_customer_id: input.customer_id,
    p_terms: assignmentPayload(input) as Json,
    p_today: todayInColombo(),
  });
  if (error) return fail(message(error));
  await onInvoiceChanged(finalInvoiceId(data));
  return ok({ agreementId: (data as { agreement_id: string }).agreement_id });
}

const SETTLEMENT_FIELD = { deduct: "deduct", refund: "refund", retain: "retain" } as const;

/** Checks a split against the deposit held and the deductible invoices (+ the final invoice on return). */
async function checkSettlement(agreementId: string, s: SettlementInput, finalInvoiceCents: number): Promise<ActionResult> {
  const state = await getDepositState(createAdminClient(), agreementId);
  const invoices = [...state.invoices];
  if (finalInvoiceCents > 0) invoices.push({ id: "final", invoiceNo: null, balanceCents: finalInvoiceCents, deductible: true, status: "AWAITING_PAYMENT", dueDate: null, totalCents: finalInvoiceCents });
  const plan = planSettlement(state.heldCents, invoices, s, s.retainReason);
  if (plan.ok) return ok(undefined);
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(plan.errors)) {
    if (key !== "form" && text) fields[SETTLEMENT_FIELD[key as keyof typeof SETTLEMENT_FIELD]] = text;
  }
  return fail(plan.errors.form ?? "Please check the deposit amounts.", fields);
}

/** p_return: the final invoice from the engine, the deposit choice, the request key. */
async function returnPayload(actor: CurrentUser, agreementId: string, input: ReturnInput): Promise<ActionResult<Json>> {
  const admin = createAdminClient();
  const today = todayInColombo();
  const context = await loadReturnContext(admin, agreementId, today);
  let submission;
  try {
    submission = buildReturnInvoice(context, {
      closing: { BW: input.closing_bw, COLOUR: input.closing_colour },
      rule: input.rule,
      creditsExcluded: input.creditsExcluded,
    });
  } catch (e) {
    if (e instanceof BillingError) {
      const field = e.counter === "COLOUR" ? "closing_colour" : "closing_bw";
      return fail("Please check the closing readings.", { [field]: e.message });
    }
    throw e;
  }
  if (input.deposit) {
    const checked = await checkSettlement(agreementId, input.deposit, submission?.invoice.total_cents ?? 0);
    if (!checked.ok) return checked;
  }
  const { data: branding } = await admin.from("owner_company_profiles").select(BRANDING_SNAPSHOT_COLUMNS).eq("owner_id", actor.id).maybeSingle();
  const dueDate = addDays(today, context.dueDays);
  return ok({
    idempotency_key: input.idempotency_key,
    reason: input.reason,
    closing: { bw: input.closing_bw, colour: input.closing_colour },
    final: submission && {
      rule: input.rule,
      readings: submission.readings,
      invoice: submission.invoice,
      anomaly_flag: submission.anomalyFlag,
      due_date: dueDate,
      stage_due_at: `${dueDate}T23:59:59+05:30`,
      branding_snapshot: brandingSnapshot(branding, new Date()),
    },
    deposit: input.deposit && settlementPayload(input.deposit),
  } as unknown as Json);
}

export async function returnMachine(actor: CurrentUser, agreementId: string, input: ReturnInput): Promise<ActionResult> {
  const payload = await returnPayload(actor, agreementId, input);
  if (!payload.ok) return payload;
  const { data, error } = await createAdminClient().rpc("rpc_return_machine", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_return: payload.data,
    p_today: todayInColombo(),
  });
  if (error) return fail(message(error));
  // INV-09: the final invoice's PDF (the daily job retries if this fails).
  await onInvoiceChanged(finalInvoiceId(data));
  return ok(undefined);
}

/** The final invoice issued by a return (or the return part of a reassign). */
function finalInvoiceId(result: unknown): string | null {
  const r = result as { final_invoice_id?: string | null; returned?: { final_invoice_id?: string | null } } | null;
  return r?.final_invoice_id ?? r?.returned?.final_invoice_id ?? null;
}

/** Return + new assignment in one transaction: both happen or neither does. */
export async function reassignMachine(
  actor: CurrentUser,
  agreementId: string,
  closing: ReturnInput,
  assignment: AssignmentInput,
): Promise<ActionResult<{ agreementId: string }>> {
  const payload = await returnPayload(actor, agreementId, closing);
  if (!payload.ok) return payload;
  const { data, error } = await createAdminClient().rpc("rpc_reassign_machine", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_return: payload.data,
    p_customer_id: assignment.customer_id,
    p_terms: assignmentPayload(assignment) as Json,
    p_today: todayInColombo(),
  });
  if (error) return fail(message(error));
  await onInvoiceChanged(finalInvoiceId(data));
  return ok({ agreementId: (data as { agreement_id: string }).agreement_id });
}

/** DEP-03/04, settle later: on a returned agreement whose deposit is still held. */
export async function settleDeposit(actor: CurrentUser, agreementId: string, input: SettlementInput): Promise<ActionResult> {
  const checked = await checkSettlement(agreementId, input, 0);
  if (!checked.ok) return checked;
  const { error } = await createAdminClient().rpc("rpc_settle_deposit", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_settlement: settlementPayload(input) as Json,
    p_today: todayInColombo(),
  });
  return error ? fail(message(error)) : ok(undefined);
}

export interface TermsChange {
  pricingChanged: boolean;
  effectiveFromCycleNo: number | null;
  effectiveFromDate: string | null;
}

export async function updateAgreementTerms(
  actor: CurrentUser,
  agreementId: string,
  input: TermsEditInput,
): Promise<ActionResult<TermsChange>> {
  const { data, error } = await createAdminClient().rpc("rpc_update_agreement_terms", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_terms: {
      ...termsPayload(input),
      installation_location: input.installation_location,
      end_date: input.end_date,
    } as Json,
    p_note: input.note as string,
    p_today: todayInColombo(),
  });
  if (error) return fail(message(error));
  const r = data as { pricing_changed: boolean; effective_from_cycle_no: number | null; effective_from_date: string | null };
  return ok({ pricingChanged: r.pricing_changed, effectiveFromCycleNo: r.effective_from_cycle_no, effectiveFromDate: r.effective_from_date });
}
