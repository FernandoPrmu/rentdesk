"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AssignmentFields, TermsFields, type TermsDefaults } from "@/components/agreements/agreement-fields";
import { SettlementFields } from "@/components/agreements/deposit-fields";
import { type ReturnFormData, ReturnFields } from "@/components/agreements/return-fields";
import { FormError, FormField } from "@/components/forms/form-field";
import { type FormAction, useFormAction } from "@/components/forms/use-form-action";
import { Button } from "@/components/ui/button";
import type { TermsChange } from "@/lib/agreements/service";
import { formatDate } from "@/lib/format";
import type { MachineType } from "@/lib/machines/schemas";

const submitClass = "h-12 w-full text-base sm:w-auto sm:px-8";

/** Assign a machine (MAC-02, DEP-01/02). On success the action redirects to the agreement. */
export function AssignmentForm({
  type,
  today,
  customers,
  fixedCustomer,
  ownerLateFee,
  action,
}: {
  type: MachineType;
  today: string;
  customers?: { id: string; name: string }[];
  fixedCustomer?: { id: string; name: string };
  ownerLateFee: string;
  action: FormAction;
}) {
  const { onSubmit, pending, errors, formError } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <AssignmentFields type={type} today={today} customers={customers} fixedCustomer={fixedCustomer} ownerLateFee={ownerLateFee} errors={errors} />
      <FormError message={formError} />
      <Button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : "Assign machine"}
      </Button>
    </form>
  );
}

/** Return (MAC-04, RET-01). On success the action redirects to the machine. */
export function ReturnForm({ data, action }: { data: ReturnFormData; action: FormAction }) {
  const { onSubmit, pending, errors, formError } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <ReturnFields data={data} errors={errors} />
      <FormError message={formError} />
      <Button type="submit" variant="destructive" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : "Return machine"}
      </Button>
    </form>
  );
}

/** Reassign (MAC-04): return from the current customer (same rules) and assign to a new one, saved together. */
export function ReassignForm({
  data,
  currentCustomer,
  customers,
  ownerLateFee,
  action,
}: {
  data: ReturnFormData;
  currentCustomer: string;
  customers: { id: string; name: string }[];
  ownerLateFee: string;
  action: FormAction;
}) {
  const { onSubmit, pending, errors, formError } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">1. Return from {currentCustomer}</h2>
        <ReturnFields data={data} errors={errors} />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">2. Assign to the new customer</h2>
        <AssignmentFields type={data.type} today={data.today} customers={customers} ownerLateFee={ownerLateFee} errors={errors} />
      </section>
      <FormError message={formError} />
      <p className="text-sm text-muted-foreground">Both steps are saved together. If one fails, nothing changes.</p>
      <Button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : "Return and reassign"}
      </Button>
    </form>
  );
}

/** DEP-03/04 settle later: on a returned agreement whose deposit is still held. */
export function SettleDepositForm({
  heldCents,
  deductibleCents,
  today,
  action,
}: {
  heldCents: number;
  deductibleCents: number;
  today: string;
  action: FormAction;
}) {
  const { onSubmit, pending, errors, formError } = useFormAction(action, () => toast.success("Deposit settled"));
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <SettlementFields heldCents={heldCents} deductibleCents={deductibleCents} today={today} errors={errors} />
      <FormError message={formError} />
      <Button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : "Settle deposit"}
      </Button>
    </form>
  );
}

/**
 * Edit terms (AGR-02, LATE-01). Price and late fee changes apply from the next
 * cycle only; the form says from which cycle and date before and after saving.
 */
export function TermsEditForm({
  type,
  defaults,
  location,
  endDate,
  nextCycle,
  ownerLateFee,
  action,
}: {
  type: MachineType;
  defaults: TermsDefaults;
  location: string;
  endDate: string | null;
  nextCycle: { cycleNo: number; date: string };
  ownerLateFee: string;
  action: FormAction<TermsChange>;
}) {
  const [saved, setSaved] = useState<TermsChange | null>(null);
  const { onSubmit, pending, errors, formError } = useFormAction(action, (change) => {
    setSaved(change);
    toast.success(
      change.pricingChanged && change.effectiveFromDate
        ? `Saved. New terms apply from cycle ${change.effectiveFromCycleNo} (${formatDate(change.effectiveFromDate)}).`
        : "Changes saved",
    );
  });
  return (
    // Saved values come back as new defaults: remount so the inputs pick them up.
    <form key={JSON.stringify({ defaults, location, endDate })} onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm" data-testid="terms-effective-note">
        Price and late fee changes apply <strong>from the next cycle</strong>: cycle {nextCycle.cycleNo}, due {formatDate(nextCycle.date)}. Open
        and earlier invoices keep their terms.
      </p>
      <TermsFields type={type} defaults={defaults} ownerLateFee={ownerLateFee} errors={errors} />
      <FormField name="installation_location" label="Installation location" required defaultValue={location} error={errors.installation_location} hint="Changes at once." />
      <FormField name="end_date" label="End date" type="date" defaultValue={endDate ?? ""} error={errors.end_date} hint="Changes at once." />
      <FormField name="note" label="Note for the history" multiline error={errors.note} />
      <FormError message={formError} />
      {saved?.pricingChanged && saved.effectiveFromDate && (
        <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-sm">
          New terms saved. They apply from cycle {saved.effectiveFromCycleNo}, due {formatDate(saved.effectiveFromDate)}.
        </p>
      )}
      <Button type="submit" disabled={pending} className={submitClass}>
        {pending ? "Saving…" : "Save terms"}
      </Button>
    </form>
  );
}
