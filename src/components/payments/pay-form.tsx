"use client";

import { Check, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { FormError, FormField, SelectField } from "@/components/forms/form-field";
import { SlipPicker, type UploadedSlip } from "@/components/payments/slip-picker";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate, formatDateTime } from "@/lib/format";
import { browserStorage, type DraftStorage } from "@/lib/meter/draft";
import { centsToRupeesInput, formatRupees, rupeesToCents } from "@/lib/money";
import { describePlan, planAllocation } from "@/lib/payments/allocation";
import { duplicateText } from "@/lib/payments/duplicates";
import type { CustomerPaymentInput } from "@/lib/payments/schemas";
import type { DuplicateWarning, PayView, SubmitResult } from "@/lib/payments/service";
import { PAYMENT_METHOD_LABEL, REFERENCE_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/**
 * The customer pays one or more bills with one slip (CP-04, PAY-02; decision 39):
 * tick the bills, check the amount, date, method and reference, add the slip and
 * send. The split preview uses the same rule as the server (oldest due first).
 * The typed details and the idempotency key stay on the device until the server
 * confirms, so a lost connection or a double tap never sends twice.
 */

const METHODS = ["BANK_TRANSFER", "DEPOSIT", "CHEQUE", "OTHER"] as const;
const DRAFT_KEY = "rentdesk:pay-draft";
const DRAFT_MAX_AGE_MS = 86_400_000;

interface Draft {
  idempotencyKey: string;
  paidOn: string;
  method: string;
  reference: string;
  note: string;
  savedAt: string;
}

function loadDraft(storage: DraftStorage | null): Draft | null {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return Date.now() - Date.parse(d.savedAt) < DRAFT_MAX_AGE_MS && typeof d.idempotencyKey === "string" ? d : null;
  } catch {
    return null;
  }
}

function saveDraft(storage: DraftStorage | null, d: Omit<Draft, "savedAt">) {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
  } catch {
    // The draft is only a convenience.
  }
}

export function PayForm({ view, action }: { view: PayView; action: (input: CustomerPaymentInput) => Promise<ActionResult<SubmitResult>> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<string[]>(view.preselected.length > 0 ? view.preselected : view.bills.length === 1 ? [view.bills[0].id] : []);
  const [amount, setAmount] = useState("");
  const [amountEdited, setAmountEdited] = useState(false);
  const [paidOn, setPaidOn] = useState(view.today);
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [slip, setSlip] = useState<UploadedSlip | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateWarning | null>(null);

  // The draft (details and key) survives a refresh; the slip is uploaded again.
  useEffect(() => {
    const d = loadDraft(browserStorage());
    /* eslint-disable react-hooks/set-state-in-effect -- read the device draft once, after hydration */
    setKey(d?.idempotencyKey ?? crypto.randomUUID());
    if (d) {
      setPaidOn(d.paidOn || view.today);
      setMethod(d.method || "BANK_TRANSFER");
      setReference(d.reference);
      setNote(d.note);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [view.today]);

  useEffect(() => {
    if (key) saveDraft(browserStorage(), { idempotencyKey: key, paidOn, method, reference, note });
  }, [key, paidOn, method, reference, note]);

  const chosen = view.bills.filter((b) => selected.includes(b.id));
  const totalDue = chosen.reduce((sum, b) => sum + b.balanceCents, 0);
  const amountCents = amountEdited ? rupeesToCents(amount) : totalDue;
  const plan =
    amountCents && amountCents > 0
      ? planAllocation(amountCents, chosen.map((b) => ({ id: b.id, invoiceNo: b.invoiceNo, dueDate: b.dueDate, seq: b.seq, balanceCents: b.balanceCents })))
      : null;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function send(confirmDuplicate: boolean) {
    if (!key) return;
    setFormError(null);
    const local: Record<string, string> = {};
    if (chosen.length === 0) local.invoiceIds = "Choose at least one bill.";
    if (!slip) local.slip = "Add a photo or file of the payment slip.";
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    start(async () => {
      try {
        const result = await action({
          idempotencyKey: key,
          invoiceIds: plan ? plan.allocations.map((a) => a.invoiceId) : selected,
          amount: amountEdited ? amount : centsToRupeesInput(totalDue),
          paidOn,
          method: method as CustomerPaymentInput["method"],
          reference,
          note,
          slipPath: slip!.path,
          originalSha256: slip!.originalSha256,
          confirmDuplicate,
        });
        if (!result.ok) {
          setErrors(result.fieldErrors ?? {});
          setFormError(result.error);
          if (result.fieldErrors?.slip) setSlip(null);
          return;
        }
        if ("needsConfirm" in result.data) {
          setDuplicate(result.data.duplicate);
          return;
        }
        try {
          browserStorage()?.removeItem(DRAFT_KEY);
        } catch {
          // Nothing to do.
        }
        router.push(`/customer/payments/${result.data.paymentId}?sent=1`);
      } catch {
        setFormError("The server could not be reached. Your details are kept: please try again.");
      }
    });
  }

  if (view.bills.length === 0) {
    return (
      <div className="space-y-3 rounded-xl border bg-background p-5">
        <p className="text-lg font-semibold">Nothing to pay right now</p>
        {view.waiting.length > 0 && <p className="text-sm text-muted-foreground">Your slip for {view.waiting.map((w) => w.invoiceNo).join(", ")} is being checked.</p>}
        {view.blocked.map((b) => (
          <p key={b.invoiceNo} className="text-sm text-muted-foreground">
            {b.invoiceNo}: {b.reason}
          </p>
        ))}
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        send(false);
      }}
      noValidate
    >
      <fieldset className="space-y-2">
        <legend className="mb-2 text-lg font-semibold">Which bills are you paying?</legend>
        <ul className="divide-y overflow-hidden rounded-xl border bg-background">
          {view.bills.map((b) => {
            const on = selected.includes(b.id);
            return (
              <li key={b.id}>
                <label className={cn("flex min-h-16 cursor-pointer items-center gap-3 px-4 py-3", on && "bg-primary/5")}>
                  <input type="checkbox" className="size-6 shrink-0 accent-primary" checked={on} onChange={() => toggle(b.id)} data-testid="pay-bill" aria-label={`Pay ${b.invoiceNo}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{b.invoiceNo}</span>
                    <span className={cn("block text-sm text-muted-foreground", b.overdue && "font-medium text-destructive")}>
                      {b.machine} · {b.dueDate ? `${b.overdue ? "was due" : "due"} ${formatDate(b.dueDate)}` : "due on receipt"}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatRupees(b.balanceCents)}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {errors.invoiceIds && <p className="text-sm text-destructive">{errors.invoiceIds}</p>}
        {view.waiting.length > 0 && <p className="text-sm text-muted-foreground">Being checked already: {view.waiting.map((w) => w.invoiceNo).join(", ")}.</p>}
      </fieldset>

      {view.bank && (
        <div className="rounded-xl border bg-muted/40 p-4 text-sm">
          <p className="font-semibold">Pay {view.companyName}</p>
          <p>
            {view.bank.name}
            {view.bank.branch ? `, ${view.bank.branch}` : ""}
          </p>
          {view.bank.accountName && <p>Account name: {view.bank.accountName}</p>}
          {view.bank.accountNo && (
            <p>
              Account number: <span className="font-semibold tabular-nums">{view.bank.accountNo}</span>
            </p>
          )}
          {view.instructions && <p className="mt-1 text-muted-foreground">{view.instructions}</p>}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="amount"
          label="Amount paid"
          prefix="Rs."
          inputMode="decimal"
          required
          value={amountEdited ? amount : totalDue > 0 ? centsToRupeesInput(totalDue) : ""}
          onChange={(v) => {
            setAmountEdited(true);
            setAmount(v);
          }}
          error={errors.amount}
          hint={totalDue > 0 ? `Total of the ticked bills: ${formatRupees(totalDue)}` : undefined}
        />
        <FormField name="paidOn" label="Date paid" type="date" required max={view.today} value={paidOn} onChange={setPaidOn} error={errors.paidOn} />
        <SelectField
          name="method"
          label="How did you pay?"
          required
          value={method}
          onChange={setMethod}
          options={METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))}
          error={errors.method}
        />
        <FormField
          name="reference"
          label={REFERENCE_LABEL[method] ?? "Reference"}
          required={method !== "OTHER"}
          value={reference}
          onChange={setReference}
          error={errors.reference}
          hint="As printed on the slip or shown in your bank app."
        />
      </div>
      <FormField name="note" label="Note for your rental company" multiline value={note} onChange={setNote} error={errors.note} />

      <SlipPicker ownerId={view.ownerId} customerId={view.customerId} value={slip} onChange={setSlip} error={errors.slip} />

      {plan && chosen.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-primary/5 p-3 text-sm" data-testid="pay-plan">
          <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {describePlan(plan, formatRupees)}
          {plan.leftOut.length > 0 && ` ${plan.leftOut.length === 1 ? "One bill is" : `${plan.leftOut.length} bills are`} not reached by this amount and stays to pay.`}
        </p>
      )}

      <FormError message={formError} />
      <Button type="submit" className="h-14 w-full text-base" disabled={pending || !key}>
        {pending ? "Sending…" : "Send payment slip"}
      </Button>

      <AlertDialog open={duplicate !== null} onOpenChange={(open) => !open && setDuplicate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-destructive" aria-hidden /> Already sent?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {duplicate ? duplicateText(duplicate.reasons) : ""}
              {duplicate?.own && duplicate.date ? ` You sent it on ${formatDateTime(duplicate.date)}.` : ""} Send it only if this is a new payment. Your rental company will check it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={pending}>
              Go back
            </AlertDialogCancel>
            <Button
              type="button"
              className="h-11"
              disabled={pending}
              onClick={() => {
                setDuplicate(null);
                send(true);
              }}
            >
              Send anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
