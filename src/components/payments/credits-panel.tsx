"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { FormError, FormField, SelectField } from "@/components/forms/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/format";
import { centsToRupeesInput, formatRupees } from "@/lib/money";
import type { RefundInput } from "@/lib/payments/schemas";
import type { CreditView } from "@/lib/payments/service";
import { CREDIT_KIND_LABEL, CREDIT_STATUS_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/status-labels";

/**
 * PAY-12: the customer's credits on their profile, and refunding what is free of
 * one (not used by an invoice, not reserved by a draft). Credits otherwise come
 * off the next invoices automatically (rule 13).
 */

const METHODS = ["CASH", "CHEQUE", "BANK_TRANSFER", "DEPOSIT", "OTHER"] as const;

export function CreditsPanel({ credits, today, action }: { credits: CreditView[]; today: string; action: (input: RefundInput) => Promise<ActionResult<{ leftCents: number }>> }) {
  const [refunding, setRefunding] = useState<CreditView | null>(null);
  if (credits.length === 0) return <p className="text-sm text-muted-foreground">No credits.</p>;
  return (
    <>
      <ul className="divide-y" aria-label="Credits">
        {credits.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="credit-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{CREDIT_KIND_LABEL[c.kind] ?? c.kind}</span>
                <Badge variant={c.status === "AVAILABLE" ? "secondary" : "outline"}>{CREDIT_STATUS_LABEL[c.status] ?? c.status}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {formatRupees(c.amountCents)} on {formatDate(c.createdAt.slice(0, 10))}
                {c.refundedCents > 0 ? ` · ${formatRupees(c.refundedCents)} refunded` : ""}
                {c.availableCents > 0 ? ` · ${formatRupees(c.availableCents)} free` : ""}
              </p>
              {c.refunds.map((r, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  Refunded {formatRupees(r.amount_cents)} on {formatDate(r.refunded_on)} by {PAYMENT_METHOD_LABEL[r.method] ?? r.method}
                  {r.reference ? ` (${r.reference})` : ""}
                </p>
              ))}
            </div>
            {c.availableCents > 0 && (
              <Button type="button" variant="outline" className="h-11" onClick={() => setRefunding(c)} data-testid="refund-credit">
                Refund
              </Button>
            )}
          </li>
        ))}
      </ul>
      <AlertDialog open={refunding !== null} onOpenChange={(open) => !open && setRefunding(null)}>
        <AlertDialogContent>{refunding && <RefundForm credit={refunding} today={today} action={action} onDone={() => setRefunding(null)} />}</AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RefundForm({ credit, today, action, onDone }: { credit: CreditView; today: string; action: (input: RefundInput) => Promise<ActionResult<{ leftCents: number }>>; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState(centsToRupeesInput(credit.availableCents));
  const [refundedOn, setRefundedOn] = useState(today);
  const [method, setMethod] = useState<string>("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const result = await action({ creditId: credit.id, amount, refundedOn, method: method as RefundInput["method"], reference, note });
            if (!result.ok) {
              setErrors(result.fieldErrors ?? {});
              setFormError(result.error);
              return;
            }
            toast.success("Refund recorded. The customer was told.");
            onDone();
            router.refresh();
          } catch {
            setFormError("The server could not be reached. Please try again.");
          }
        });
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>Refund the credit</AlertDialogTitle>
        <AlertDialogDescription>
          Up to {formatRupees(credit.availableCents)} is free to refund. Record it after you paid the money back.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <FormField name="amount" label="Amount refunded" prefix="Rs." inputMode="decimal" required value={amount} onChange={setAmount} error={errors.amount} />
      <FormField name="refundedOn" label="Date refunded" type="date" required max={today} value={refundedOn} onChange={setRefundedOn} error={errors.refundedOn} />
      <SelectField name="method" label="How it was refunded" required value={method} onChange={setMethod} options={METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))} error={errors.method} />
      <FormField name="reference" label="Reference" value={reference} onChange={setReference} error={errors.reference} />
      <FormField name="note" label="Note" multiline value={note} onChange={setNote} error={errors.note} />
      <FormError message={formError} />
      <AlertDialogFooter>
        <AlertDialogCancel className="h-11" disabled={pending} onClick={onDone}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" className="h-11" disabled={pending}>
          {pending ? "Saving…" : "Record refund"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
