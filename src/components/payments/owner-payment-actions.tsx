"use client";

import { ArrowLeftRight, Check, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/forms/form-field";
import { ReasonDialog } from "@/components/forms/reason-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/format";
import { formatRupees, rupeesToCents } from "@/lib/money";
import { type AllocatableInvoice, describePlan, planAllocation } from "@/lib/payments/allocation";
import type { VerifyInput } from "@/lib/payments/schemas";
import { cn } from "@/lib/utils";

/**
 * The owner's actions on one payment (PAY-05, TKT-10, 11.5): check a slip
 * (accept, accept the amount really received, reject with a reason), and for an
 * accepted payment: reverse it or move it to other bills. Previews use the same
 * split as the database (oldest due first); the rpc decides.
 */

const ownerPlanText = (plan: ReturnType<typeof planAllocation>) =>
  describePlan(plan, formatRupees).replace("for your next bills", "for the customer's next bills");

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(task: () => Promise<ActionResult<T>>, success: (data: T) => string, after?: () => void) =>
    start(async () => {
      try {
        const result = await task();
        if (result.ok) {
          toast.success(success(result.data));
          after?.();
          router.refresh();
        } else toast.error(result.error);
      } catch {
        toast.error("The server could not be reached. Please try again.");
      }
    });
  return { pending, run };
}

export function VerifyPanel({
  paymentId,
  slipCents,
  bills,
  action,
}: {
  paymentId: string;
  slipCents: number;
  bills: AllocatableInvoice[];
  action: (input: VerifyInput) => Promise<ActionResult<{ status: string; receiptNo: string | null }>>;
}) {
  const { pending, run } = useRun();
  const [other, setOther] = useState(false);
  const [amount, setAmount] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const router = useRouter();
  const otherCents = other ? rupeesToCents(amount) : null;
  const accepted = other ? otherCents : slipCents;
  const valid = accepted !== null && accepted > 0 && accepted <= slipCents;
  const plan = valid ? planAllocation(accepted, bills) : null;

  return (
    <div className="space-y-3" data-testid="verify-panel">
      {plan && <p className="rounded-lg bg-muted p-3 text-sm" data-testid="verify-plan">{ownerPlanText(plan)}</p>}
      {other && (
        <FormField
          name="amount"
          label="Amount you received"
          prefix="Rs."
          inputMode="decimal"
          required
          value={amount}
          onChange={setAmount}
          error={amount.trim() !== "" && !valid ? `Enter an amount up to ${formatRupees(slipCents)}.` : undefined}
          hint="What reached your bank account, if it is less than the slip."
        />
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Button
          type="button"
          className="h-12 gap-2 text-base"
          disabled={pending || !valid}
          onClick={() =>
            run(
              () => action({ decision: "ACCEPT", paymentId, amount: other ? amount : "" }),
              (d) => (d.status === "PARTIAL" ? `Part payment accepted. Receipt ${d.receiptNo}` : `Payment accepted. Receipt ${d.receiptNo}`),
            )
          }
        >
          <Check className="size-5" aria-hidden /> {other ? (valid ? `Accept ${formatRupees(accepted)}` : "Accept") : `Accept ${formatRupees(slipCents)}`}
        </Button>
        <Button type="button" variant="outline" className="h-12 text-base" disabled={pending} onClick={() => setOther((v) => !v)}>
          {other ? "Received the full amount" : "Received less"}
        </Button>
        <Button type="button" variant="outline" className="h-12 gap-2 text-base text-destructive" disabled={pending} onClick={() => setRejecting(true)}>
          <X className="size-5" aria-hidden /> Reject
        </Button>
      </div>
      <ReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject the payment slip"
        description="The customer is told why and can send a new slip. The bills wait for payment again."
        confirmLabel="Reject"
        placeholder="For example: the amount is not in our account"
        destructive
        onConfirm={async (reason) => {
          const result = await action({ decision: "REJECT", paymentId, reason });
          if (result.ok) {
            toast.success("Slip rejected. The customer was told.");
            setRejecting(false);
            router.refresh();
          }
          return result;
        }}
      />
    </div>
  );
}

export interface MoveOption extends AllocatableInvoice {
  machine: string;
}

export function AcceptedPaymentActions({
  paymentId,
  acceptedCents,
  current,
  options,
  reverse,
  move,
}: {
  paymentId: string;
  acceptedCents: number;
  /** Bills the payment is on now. */
  current: string[];
  /** Bills it can be moved to (balances as if this payment were not on them). */
  options: MoveOption[];
  reverse: (input: { paymentId: string; reason: string }) => Promise<ActionResult>;
  move: (input: { paymentId: string; invoiceIds: string[]; reason: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [reversing, setReversing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [chosen, setChosen] = useState<string[]>(current);
  const plan = planAllocation(acceptedCents, options.filter((o) => chosen.includes(o.id)));
  const same = chosen.length === current.length && chosen.every((id) => current.includes(id));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="h-12 gap-2 text-base" onClick={() => setMoving(true)}>
          <ArrowLeftRight className="size-5" aria-hidden /> Move to other bills
        </Button>
        <Button type="button" variant="outline" className="h-12 gap-2 text-base text-destructive" onClick={() => setReversing(true)}>
          <Undo2 className="size-5" aria-hidden /> Reverse payment
        </Button>
      </div>

      <ReasonDialog
        open={reversing}
        onOpenChange={setReversing}
        title="Reverse this payment"
        description="Use this when the money did not arrive (for example a returned cheque). Its bills are owed again, a closed ticket is reopened, any credit it made is removed, and the receipt is marked REVERSED. The customer is told."
        confirmLabel="Reverse payment"
        placeholder="For example: cheque returned by the bank"
        destructive
        onConfirm={async (reason) => {
          const result = await reverse({ paymentId, reason });
          if (result.ok) {
            toast.success("Payment reversed. The customer was told.");
            setReversing(false);
            router.refresh();
          }
          return result;
        }}
      />

      <ReasonDialog
        open={moving}
        onOpenChange={(open) => {
          setMoving(open);
          if (!open) setChosen(current);
        }}
        title="Move the payment to other bills"
        description="Tick the bills this payment is really for. It is split again, oldest due first; the receipt keeps its number and gets a new version. The customer is told."
        confirmLabel="Move payment"
        placeholder="For example: the customer meant the March bill"
        onConfirm={async (reason) => {
          if (same) return { ok: false, error: "Choose other bills than the ones the payment is on now." };
          const result = await move({ paymentId, invoiceIds: chosen, reason });
          if (result.ok) {
            toast.success("Payment moved. The receipt was updated.");
            setMoving(false);
            router.refresh();
          }
          return result;
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Bills</legend>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {options.map((o) => (
              <li key={o.id}>
                <label className={cn("flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm", chosen.includes(o.id) && "bg-primary/5")}>
                  <input
                    type="checkbox"
                    className="size-5 accent-primary"
                    checked={chosen.includes(o.id)}
                    onChange={() => setChosen((c) => (c.includes(o.id) ? c.filter((x) => x !== o.id) : [...c, o.id]))}
                    aria-label={`Move to ${o.invoiceNo}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{o.invoiceNo}</span>
                    <span className="block text-xs text-muted-foreground">
                      {o.machine}
                      {o.dueDate ? ` · due ${formatDate(o.dueDate)}` : ""}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatRupees(o.balanceCents)}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground" data-testid="move-plan">{ownerPlanText(plan)}</p>
        </fieldset>
      </ReasonDialog>
    </div>
  );
}
