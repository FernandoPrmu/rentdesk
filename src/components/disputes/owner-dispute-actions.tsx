"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/forms/form-field";
import { ReasonDialog } from "@/components/forms/reason-dialog";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import type { OwnerDisputeAction } from "@/lib/disputes/service";
import { formatRupees, rupeesToCents } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * The owner's answers to an open dispute (11.4; decisions 47-49): reject it (the
 * bill stands; optional new due date), correct the bill (cancel and reissue, on its
 * own page), or give a credit off the bill; and ask for a fresh meter photo first.
 * Each needs a reason the customer sees.
 */
export function OwnerDisputeActions({
  ticketId,
  today,
  leftToPayCents,
  photoPending,
  action,
}: {
  ticketId: string;
  today: string;
  leftToPayCents: number;
  /** A fresh photo was asked for and has not arrived yet. */
  photoPending: boolean;
  action: (ticketId: string, input: OwnerDisputeAction) => Promise<ActionResult<{ status?: string }>>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState<"reject" | "credit" | "photo" | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [amount, setAmount] = useState("");

  const run = (input: OwnerDisputeAction, message: string) => async () => {
    const result = await action(ticketId, input);
    if (result.ok) {
      toast.success(message);
      setOpen(null);
      router.refresh();
    }
    return result;
  };
  const cents = rupeesToCents(amount);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-testid="dispute-actions">
      <Button type="button" variant="outline" className="h-12 text-base" disabled={!hydrated} onClick={() => setOpen("reject")}>
        Reject dispute
      </Button>
      <Link href={`/owner/tickets/${ticketId}/correct`} className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
        Correct the bill
      </Link>
      <Button type="button" variant="outline" className="h-12 text-base" disabled={!hydrated} onClick={() => setOpen("credit")}>
        Give a credit
      </Button>
      {!photoPending && (
        <Button type="button" variant="ghost" className="h-12 text-base" disabled={!hydrated} onClick={() => setOpen("photo")}>
          Ask for a fresh meter photo
        </Button>
      )}

      <ReasonDialog
        open={open === "reject"}
        onOpenChange={(o) => setOpen(o ? "reject" : null)}
        title="Reject the dispute"
        description="The bill stays as it is. Explain why; the customer sees it. You can give a new due date."
        confirmLabel="Reject dispute"
        placeholder="For example: the reading matches the photo of the meter"
        onConfirm={(reason) => run({ action: "reject", reason, dueDate: dueDate || null }, "Dispute rejected. The customer was told.")()}
      >
        <FormField name="dueDate" label="New due date" type="date" min={today} value={dueDate} onChange={setDueDate} hint="Leave empty to keep the due date." />
      </ReasonDialog>

      <ReasonDialog
        open={open === "credit"}
        onOpenChange={(o) => setOpen(o ? "credit" : null)}
        title="Give a credit"
        description={`The credit is taken off this bill (${formatRupees(leftToPayCents)} left to pay). Anything above that is kept as credit for the next bills.`}
        confirmLabel="Give credit"
        placeholder="For example: copies lost to a paper jam"
        onConfirm={(reason) => {
          if (!cents) return Promise.resolve({ ok: false as const, error: "Enter the credit in rupees, for example 1500." });
          return run({ action: "credit", reason, amount }, "Credit given. The customer was told.")();
        }}
      >
        <FormField
          name="amount"
          label="Credit (Rs.)"
          required
          inputMode="decimal"
          value={amount}
          onChange={setAmount}
          hint={cents && cents > leftToPayCents ? `${formatRupees(leftToPayCents)} off this bill, ${formatRupees(cents - leftToPayCents)} kept for the next bills.` : undefined}
        />
      </ReasonDialog>

      <ReasonDialog
        open={open === "photo"}
        onOpenChange={(o) => setOpen(o ? "photo" : null)}
        title="Ask for a fresh meter photo"
        description="The customer takes a new live photo of the meter and types what it shows. It is deleted when the dispute ends."
        confirmLabel="Ask for photo"
        placeholder="For example: please show the counter page with B&W and colour"
        onConfirm={(note) => run({ action: "requestPhoto", note }, "The customer was asked for a fresh photo.")()}
      />
    </div>
  );
}
