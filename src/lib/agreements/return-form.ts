import "server-only";

import { randomUUID } from "node:crypto";

import type { ReturnFormData } from "@/components/agreements/return-fields";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { type AgreementDetail, getLastKnownReadings } from "@/lib/agreements/queries";
import { loadReturnContext } from "@/lib/billing/context";
import { getDepositState } from "@/lib/deposits/queries";
import { createClient } from "@/lib/supabase/server";

/**
 * Data for the return and reassign forms (RET-01, DEP-03): the billing context of
 * the final invoice (so the browser can preview it with the same engine), the
 * unpaid invoices and the deposit held. Loaded as the owner (RLS).
 */
export async function getReturnFormData(agreement: AgreementDetail): Promise<ReturnFormData> {
  const supabase = await createClient();
  const today = todayInColombo();
  const [context, lastReadings, deposit] = await Promise.all([
    loadReturnContext(supabase, agreement.id, today),
    getLastKnownReadings(agreement),
    getDepositState(supabase, agreement.id),
  ]);
  return {
    type: agreement.machine.type,
    today,
    idempotencyKey: randomUUID(),
    lastReadings,
    context,
    deposit: {
      heldCents: deposit.heldCents,
      invoices: deposit.invoices.map((i) => ({
        id: i.id,
        invoiceNo: i.invoiceNo,
        status: i.status,
        balanceCents: i.balanceCents,
        deductible: i.deductible,
      })),
    },
  };
}
