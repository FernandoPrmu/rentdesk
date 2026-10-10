"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/forms/form-field";
import { ReasonDialog } from "@/components/forms/reason-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { canPerform, type TicketStatus } from "@/lib/tickets/states";
import type { OwnerTicketAction } from "@/lib/tickets/owner-actions";

/**
 * TKT-10 / spec 11.1, 11.7: the owner's overrides on the ticket page. Each needs
 * a reason; a new due date also needs the date. Reversing a payment (a returned
 * cheque) is done on the payment, which reopens the ticket itself.
 */
export function OwnerTicketActions({
  ticketId,
  status,
  before,
  today,
  action,
}: {
  ticketId: string;
  status: TicketStatus;
  before: TicketStatus | null;
  today: string;
  action: (ticketId: string, input: OwnerTicketAction) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<"cancel" | "reopen" | "due" | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [pending, start] = useTransition();
  const state = { status, statusBeforeOverdue: before };
  const can = {
    cancel: canPerform("cancelTicket", "OWNER", state),
    reopen: canPerform("reopenTicket", "OWNER", state),
    request: canPerform("requestPaymentAgain", "OWNER", state),
    due: canPerform("clearOverdue", "OWNER", state),
  };
  if (!can.cancel && !can.reopen && !can.request && !can.due) return null;

  const confirm = (input: OwnerTicketAction, message: string) => async () => {
    const result = await action(ticketId, input);
    if (result.ok) {
      toast.success(message);
      setOpen(null);
      router.refresh();
    }
    return result;
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {can.request && (
        <Button
          type="button"
          className="h-12 text-base"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await action(ticketId, { action: "requestPayment" });
              if (result.ok) {
                toast.success("The customer was asked to pay again.");
                router.refresh();
              } else toast.error(result.error);
            })
          }
        >
          Ask for payment again
        </Button>
      )}
      {can.due && (
        <Button type="button" variant="outline" className="h-12 text-base" onClick={() => setOpen("due")}>
          Give a new due date
        </Button>
      )}
      {can.reopen && (
        <Button type="button" variant="outline" className="h-12 text-base" onClick={() => setOpen("reopen")}>
          Reopen ticket
        </Button>
      )}
      {can.cancel && (
        <Button type="button" variant="outline" className="h-12 text-base text-destructive" onClick={() => setOpen("cancel")}>
          Cancel ticket
        </Button>
      )}

      <ReasonDialog
        open={open === "cancel"}
        onOpenChange={(o) => setOpen(o ? "cancel" : null)}
        title="Cancel this ticket"
        description="The ticket and its bill are cancelled. Money already paid on the bill is kept as a credit. The customer is told."
        confirmLabel="Cancel ticket"
        placeholder="For example: created in error"
        destructive
        onConfirm={(reason) => confirm({ action: "cancel", reason }, "Ticket cancelled.")()}
      />
      <ReasonDialog
        open={open === "reopen"}
        onOpenChange={(o) => setOpen(o ? "reopen" : null)}
        title="Reopen this ticket"
        description="The ticket waits for you again. To take back a payment that did not arrive (for example a returned cheque), open the payment and reverse it instead."
        confirmLabel="Reopen"
        onConfirm={(reason) => confirm({ action: "reopen", reason }, "Ticket reopened.")()}
      />
      <ReasonDialog
        open={open === "due"}
        onOpenChange={(o) => setOpen(o ? "due" : null)}
        title="Give a new due date"
        description="The bill is no longer overdue until the new date. The customer is told."
        confirmLabel="Save due date"
        onConfirm={(reason) => {
          if (!dueDate) return Promise.resolve({ ok: false as const, error: "Choose the new due date." });
          return confirm({ action: "newDueDate", reason, dueDate }, "New due date saved.")();
        }}
      >
        <FormField name="dueDate" label="New due date" type="date" required min={today} value={dueDate} onChange={setDueDate} />
      </ReasonDialog>
    </div>
  );
}
