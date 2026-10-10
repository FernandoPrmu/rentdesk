"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { FormError, FormField, SelectField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/format";
import { centsToRupeesInput, formatRupees, rupeesToCents } from "@/lib/money";
import { describePlan, planAllocation } from "@/lib/payments/allocation";
import type { ManualPaymentInput } from "@/lib/payments/schemas";
import type { RecordView } from "@/lib/payments/service";
import { PAYMENT_METHOD_LABEL, REFERENCE_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/**
 * PAY-07 / 11.5: the owner records money received without a slip (cash or a
 * cheque collected, a transfer seen in the bank). Same split as slips (oldest due
 * first, the rest is credit); with no bill ticked it is an advance. Accepted at
 * once, with a receipt. The key is made when the form opens, so a double tap
 * records it once.
 */

const METHODS = ["CASH", "CHEQUE", "BANK_TRANSFER", "DEPOSIT", "OTHER"] as const;

export function RecordPaymentForm({
  view,
  action,
}: {
  view: RecordView;
  action: (input: ManualPaymentInput) => Promise<ActionResult<{ paymentId: string; receiptNo: string; replayed: boolean }>>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState<string[]>(view.bills.length === 1 ? [view.bills[0].id] : []);
  const [amount, setAmount] = useState("");
  const [edited, setEdited] = useState(false);
  const [paidOn, setPaidOn] = useState(view.today);
  const [method, setMethod] = useState<string>("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const chosen = view.bills.filter((b) => selected.includes(b.id));
  const due = chosen.reduce((sum, b) => sum + b.balanceCents, 0);
  const amountText = edited ? amount : due > 0 ? centsToRupeesInput(due) : "";
  const cents = rupeesToCents(amountText);
  const plan = cents && cents > 0 ? planAllocation(cents, chosen) : null;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="record-customer" className="text-sm font-medium">
          Customer
        </label>
        <ChoiceSelect
          id="record-customer"
          name="customer"
          ariaLabel="Customer"
          placeholder="Choose the customer"
          value={view.customer?.id ?? ""}
          onChange={(id) => router.push(id ? `/owner/payments/new?customer=${id}` : "/owner/payments/new")}
          options={view.customers.map((c) => ({ value: c.id, label: c.business_name ? `${c.name} (${c.business_name})` : c.name }))}
        />
      </div>

      {view.customer && (
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            start(async () => {
              try {
                const result = await action({
                  customerId: view.customer!.id,
                  idempotencyKey: key,
                  invoiceIds: plan ? plan.allocations.map((a) => a.invoiceId) : selected,
                  amount: amountText,
                  paidOn,
                  method: method as ManualPaymentInput["method"],
                  reference,
                  note,
                });
                if (!result.ok) {
                  setErrors(result.fieldErrors ?? {});
                  setFormError(result.error);
                  return;
                }
                toast.success(`Payment recorded. Receipt ${result.data.receiptNo}`);
                router.push(`/owner/payments/${result.data.paymentId}`);
              } catch {
                setFormError("The server could not be reached. Please try again.");
              }
            });
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 text-lg font-semibold">Bills it pays</legend>
            {view.bills.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No bill to pay now: the amount is kept as an advance (credit) for the next bills.</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border bg-background">
                {view.bills.map((b) => {
                  const on = selected.includes(b.id);
                  return (
                    <li key={b.id}>
                      <label className={cn("flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2", on && "bg-primary/5")}>
                        <input
                          type="checkbox"
                          className="size-5 accent-primary"
                          checked={on}
                          onChange={() => setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
                          aria-label={`Pays ${b.invoiceNo}`}
                          data-testid="record-bill"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{b.invoiceNo}</span>
                          <span className={cn("block text-xs text-muted-foreground", b.overdue && "text-destructive")}>
                            {b.machine}
                            {b.dueDate ? ` · due ${formatDate(b.dueDate)}` : ""}
                          </span>
                        </span>
                        <span className="font-semibold tabular-nums">{formatRupees(b.balanceCents)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="amount"
              label="Amount received"
              prefix="Rs."
              inputMode="decimal"
              required
              value={amountText}
              onChange={(v) => {
                setEdited(true);
                setAmount(v);
              }}
              error={errors.amount}
            />
            <FormField name="paidOn" label="Date received" type="date" required max={view.today} value={paidOn} onChange={setPaidOn} error={errors.paidOn} />
            <SelectField name="method" label="How it was paid" required value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} error={errors.method} />
            <FormField name="reference" label={REFERENCE_LABEL[method] ?? "Reference"} required={method === "CHEQUE"} value={reference} onChange={setReference} error={errors.reference} />
          </div>
          <FormField name="note" label="Note" multiline value={note} onChange={setNote} error={errors.note} />
          {plan && (
            <p className="rounded-lg bg-muted p-3 text-sm" data-testid="record-plan">
              {chosen.length === 0 ? `${formatRupees(plan.creditCents)} is kept as an advance (credit) for the next bills.` : describePlan(plan, formatRupees).replace("for your next bills", "for the customer's next bills")}
            </p>
          )}
          <FormError message={formError} />
          <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={pending}>
            {pending ? "Recording…" : "Record payment"}
          </Button>
        </form>
      )}
    </div>
  );
}
