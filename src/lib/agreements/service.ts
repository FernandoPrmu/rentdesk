import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { returnBlockedMessage } from "@/lib/agreements/blockers";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { type AssignmentInput, assignmentPayload, type ReturnInput, type TermsEditInput, termsPayload } from "@/lib/agreements/schemas";
import type { CurrentUser } from "@/lib/auth/current-user";
import { type DbError, dbErrorMessage } from "@/lib/db-errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/db";

/**
 * Assign, return, reassign and edit terms (MAC-02, MAC-04, AGR-01, AGR-02). Each
 * is ONE atomic rpc call that checks the owner, the tenant and the state again and
 * writes the audit log. "Today" is always Sri Lanka's date.
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
  return ok({ agreementId: (data as { agreement_id: string }).agreement_id });
}

export async function returnMachine(actor: CurrentUser, agreementId: string, input: ReturnInput): Promise<ActionResult> {
  const { error } = await createAdminClient().rpc("rpc_return_machine", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_closing: { bw: input.closing_bw, colour: input.closing_colour },
    p_reason: input.reason,
    p_today: todayInColombo(),
  });
  return error ? fail(message(error)) : ok(undefined);
}

/** Return + new assignment in one transaction: both happen or neither does. */
export async function reassignMachine(
  actor: CurrentUser,
  agreementId: string,
  closing: ReturnInput,
  assignment: AssignmentInput,
): Promise<ActionResult<{ agreementId: string }>> {
  const { data, error } = await createAdminClient().rpc("rpc_reassign_machine", {
    p_actor_id: actor.id,
    p_agreement_id: agreementId,
    p_closing: { bw: closing.closing_bw, colour: closing.closing_colour },
    p_reason: closing.reason,
    p_customer_id: assignment.customer_id,
    p_terms: assignmentPayload(assignment) as Json,
    p_today: todayInColombo(),
  });
  if (error) return fail(message(error));
  return ok({ agreementId: (data as { agreement_id: string }).agreement_id });
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
