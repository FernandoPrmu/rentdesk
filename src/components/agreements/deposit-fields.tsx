"use client";

import { useState } from "react";

import { methodOptions } from "@/components/agreements/agreement-fields";
import { FormField, SelectField } from "@/components/forms/form-field";
import { defaultSettlement } from "@/lib/deposits/settlement";
import { centsToRupeesInput, formatRupees, rupeesToCents } from "@/lib/money";
import { cn } from "@/lib/utils";

type Errors = Record<string, string>;

/**
 * DEP-03/04: split the deposit held into bills paid, refund and an amount kept.
 * The three must add up to the deposit; the line under the boxes says so as the
 * owner types. Until an amount is edited, it follows the suggestion (pay what can
 * be paid, refund the rest), which changes with the final invoice on return.
 */
export function SettlementFields({
  heldCents,
  deductibleCents,
  today,
  errors,
}: {
  heldCents: number;
  /** Unpaid balance a deposit may pay (no slip waiting, not disputed). */
  deductibleCents: number;
  today: string;
  errors: Errors;
}) {
  const [edited, setEdited] = useState<{ deduct: string; refund: string; retain: string } | null>(null);
  const suggestion = defaultSettlement(heldCents, [{ id: "all", invoiceNo: null, balanceCents: deductibleCents, deductible: true }]);
  const values = edited ?? {
    deduct: centsToRupeesInput(suggestion.deductCents),
    refund: centsToRupeesInput(suggestion.refundCents),
    retain: "0",
  };
  const set = (key: "deduct" | "refund" | "retain") => (v: string) => setEdited({ ...values, [key]: v });

  const cents = (v: string) => (v.trim() === "" ? 0 : rupeesToCents(v));
  const parts = [cents(values.deduct), cents(values.refund), cents(values.retain)];
  const total = parts.every((p) => p !== null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
  const balanced = total === heldCents;
  const refundCents = cents(values.refund) ?? 0;
  const retainCents = cents(values.retain) ?? 0;

  return (
    <div className="space-y-4">
      <FormField
        name="deduct"
        label="Pay unpaid bills"
        prefix="Rs."
        inputMode="decimal"
        value={values.deduct}
        onChange={set("deduct")}
        error={errors.deduct}
        hint={`Up to ${formatRupees(Math.min(heldCents, deductibleCents))}. Paid oldest bill first, as payments "From security deposit".`}
      />
      <FormField name="refund" label="Refund to the customer" prefix="Rs." inputMode="decimal" value={values.refund} onChange={set("refund")} error={errors.refund} />
      {refundCents > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="refunded_on" label="Refund date" type="date" required max={today} defaultValue={today} error={errors.refunded_on} />
          <SelectField name="refund_method" label="Refunded by" required placeholder="Choose…" options={methodOptions} error={errors.refund_method} />
          <FormField name="refund_reference" label="Refund reference" error={errors.refund_reference} />
        </div>
      )}
      <FormField name="retain" label="Keep" prefix="Rs." inputMode="decimal" value={values.retain} onChange={set("retain")} error={errors.retain} />
      {retainCents > 0 && <FormField name="retain_reason" label="Reason for keeping" required multiline error={errors.retain_reason} />}
      <p
        role="status"
        data-testid="deposit-total"
        className={cn("rounded-lg px-3 py-2 text-sm", balanced ? "bg-primary/5" : "bg-destructive/10 text-destructive")}
      >
        {total === null
          ? "Enter amounts in rupees, like 2,500 or 2.50."
          : balanced
            ? `Adds up to the deposit held: ${formatRupees(heldCents)}.`
            : `Pay + refund + keep is ${formatRupees(total)}; it must be ${formatRupees(heldCents)}.`}
      </p>
    </div>
  );
}
