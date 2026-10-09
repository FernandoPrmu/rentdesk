"use client";

import { useState } from "react";
import { toast } from "sonner";

import { FormError, FormField } from "@/components/forms/form-field";
import { type FormAction, useFormAction } from "@/components/forms/use-form-action";
import { Button } from "@/components/ui/button";

/** Settings › Billing: the owner's default late fee (PAY-13); agreements can override it (LATE-01). */
export function BillingSettingsForm({
  defaults,
  action,
}: {
  defaults: { late_fee_enabled: boolean; late_fee: string; grace_period_days: string };
  action: FormAction;
}) {
  const [enabled, setEnabled] = useState(defaults.late_fee_enabled);
  const { onSubmit, pending, errors, formError } = useFormAction(action, () => toast.success("Billing settings saved"));
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3">
        <input
          type="checkbox"
          name="late_fee_enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-5 accent-primary"
        />
        <span className="font-medium">Charge a late fee</span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="late_fee"
          label="Late fee"
          prefix="Rs."
          inputMode="decimal"
          required
          defaultValue={defaults.late_fee}
          error={errors.late_fee}
          hint="Charged once per invoice that is still unpaid after the grace period."
        />
        <FormField
          name="grace_period_days"
          label="Grace period (days)"
          inputMode="numeric"
          required
          defaultValue={defaults.grace_period_days}
          error={errors.grace_period_days}
          hint="Days after the due date before the fee applies."
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Never charged while a payment slip waits for your check or while the invoice is disputed. Each agreement can use this default, its own
        amount, or no late fee.
      </p>
      <FormError message={formError} />
      <Button type="submit" disabled={pending} className="h-12 w-full text-base sm:w-auto sm:px-8">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
