"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";

import { FormError, FormField } from "@/components/forms/form-field";
import { ReasonDialog } from "@/components/forms/reason-dialog";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { unreachable } from "@/lib/actions/client-errors";
import type { ActionResult } from "@/lib/action-result";
import { formatRupees, rupeesToCents } from "@/lib/money";
import type { OwnerStepForm } from "@/lib/service/service";
import type { ServiceStatus, ServiceType } from "@/lib/service/states";

/**
 * The owner's steps (SRV-03, SRV-04, SRV-07; decisions 57, 59, 60): acknowledge,
 * assign a technician and a planned visit (again later to change them), start the
 * work, resolve it with the work done, parts and cost (and optionally a charge on
 * the next bill or, for a breakdown, a discount), close it when the customer does
 * not answer, add notes, or cancel with a reason. The customer is told of each.
 */

type Action = (requestId: string, input: OwnerStepForm) => Promise<ActionResult<{ status: ServiceStatus }>>;

function useStep(requestId: string, action: Action) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = (input: OwnerStepForm, message: string, after?: () => void) =>
    start(async () => {
      setError(null);
      setFieldErrors({});
      try {
        const r = await action(requestId, input);
        if (!r.ok) {
          setError(r.error);
          setFieldErrors(r.fieldErrors ?? {});
          return;
        }
        toast.success(message);
        after?.();
        router.refresh();
      } catch {
        setError(unreachable("safe"));
      }
    });
  return { pending, error, fieldErrors, run };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-background p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function OwnerRequestActions({
  requestId,
  status,
  type,
  today,
  technician,
  plannedDate,
  hasCharge,
  hasDiscount,
  chargeAllowed,
  action,
}: {
  requestId: string;
  status: ServiceStatus;
  type: ServiceType;
  today: string;
  technician: string | null;
  plannedDate: string | null;
  hasCharge: boolean;
  hasDiscount: boolean;
  /** The machine is still rented (a charge needs a next bill). */
  chargeAllowed: boolean;
  action: Action;
}) {
  const hydrated = useHydrated();
  const step = useStep(requestId, action);
  const [dialog, setDialog] = useState<"cancel" | "note" | null>(null);
  const [showAssign, setShowAssign] = useState(false);
  const router = useRouter();
  if (status === "CLOSED" || status === "CANCELLED") return null;
  const busy = !hydrated || step.pending;

  const dialogs = (
    <>
      <ReasonDialog
        open={dialog === "cancel"}
        onOpenChange={(o) => setDialog(o ? "cancel" : null)}
        title="Cancel the request"
        description="The customer sees the reason. A charge not yet on a bill is dropped."
        confirmLabel="Cancel request"
        destructive
        placeholder="For example: the machine is being replaced"
        onConfirm={async (reason) => {
          const r = await action(requestId, { action: "CANCEL", reason });
          if (r.ok) {
            toast.success("Request cancelled. The customer was told.");
            setDialog(null);
            router.refresh();
          }
          return r;
        }}
      />
      <ReasonDialog
        open={dialog === "note"}
        onOpenChange={(o) => setDialog(o ? "note" : null)}
        title="Add a note"
        description="The customer sees the note and gets a message."
        confirmLabel="Add note"
        fieldLabel="Note"
        placeholder="For example: the part arrives on Monday"
        onConfirm={async (note) => {
          const r = await action(requestId, { action: "NOTE", note });
          if (r.ok) {
            toast.success("Note added.");
            setDialog(null);
            router.refresh();
          }
          return r;
        }}
      />
    </>
  );

  const secondary = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button type="button" variant="outline" className="h-12 text-base" disabled={busy} onClick={() => setDialog("note")}>
        Add note
      </Button>
      {(status === "ASSIGNED" || status === "IN_PROGRESS") && !showAssign && (
        <Button type="button" variant="outline" className="h-12 text-base" disabled={busy} onClick={() => setShowAssign(true)}>
          Change technician or visit
        </Button>
      )}
      <Button type="button" variant="ghost" className="h-12 text-base text-destructive" disabled={busy} onClick={() => setDialog("cancel")}>
        Cancel request
      </Button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="owner-service-actions">
      {status === "NEW" && (
        <Panel title="New request">
          <p className="text-sm text-muted-foreground">Let the customer know you have seen it.</p>
          <Button type="button" className="h-12 w-full text-base sm:w-auto" disabled={busy} onClick={() => step.run({ action: "ACKNOWLEDGE" }, "Acknowledged. The customer was told.")}>
            {step.pending ? "Saving…" : "Acknowledge"}
          </Button>
          <FormError message={step.error} />
        </Panel>
      )}
      {(status === "ACKNOWLEDGED" || showAssign) && (
        <AssignForm
          today={today}
          technician={technician}
          plannedDate={plannedDate}
          first={status === "ACKNOWLEDGED"}
          busy={busy}
          error={step.error}
          fieldErrors={step.fieldErrors}
          onSubmit={(input) => step.run(input, status === "ACKNOWLEDGED" ? "Assigned. The customer was told." : "Updated. The customer was told.", () => setShowAssign(false))}
          onCancel={status === "ACKNOWLEDGED" ? undefined : () => setShowAssign(false)}
        />
      )}
      {status === "ASSIGNED" && !showAssign && (
        <Panel title="Work">
          <Button type="button" className="h-12 w-full text-base sm:w-auto" disabled={busy} onClick={() => step.run({ action: "START" }, "Work started. The customer was told.")}>
            {step.pending ? "Saving…" : "Start work"}
          </Button>
          <FormError message={step.error} />
        </Panel>
      )}
      {status === "IN_PROGRESS" && !showAssign && (
        <ResolveForm
          type={type}
          hasCharge={hasCharge}
          hasDiscount={hasDiscount}
          chargeAllowed={chargeAllowed}
          busy={busy}
          error={step.error}
          fieldErrors={step.fieldErrors}
          onSubmit={(input) => step.run(input, "Resolved. The customer is asked to confirm.")}
        />
      )}
      {status === "RESOLVED" && (
        <Panel title="Waiting for the customer">
          <p className="text-sm text-muted-foreground">The customer is asked to confirm the fix. If they do not answer, you can close it.</p>
          <Button type="button" variant="outline" className="h-12 w-full text-base sm:w-auto" disabled={busy} onClick={() => step.run({ action: "CLOSE" }, "Request closed. The customer was told.")}>
            {step.pending ? "Saving…" : "Close request"}
          </Button>
          <FormError message={step.error} />
        </Panel>
      )}
      {secondary}
      {dialogs}
    </div>
  );
}

function AssignForm({
  today,
  technician,
  plannedDate,
  first,
  busy,
  error,
  fieldErrors,
  onSubmit,
  onCancel,
}: {
  today: string;
  technician: string | null;
  plannedDate: string | null;
  first: boolean;
  busy: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  onSubmit: (input: OwnerStepForm) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(technician ?? "");
  const [date, setDate] = useState(plannedDate && plannedDate >= today ? plannedDate : "");
  const [note, setNote] = useState("");
  return (
    <Panel title={first ? "Assign a technician" : "Change technician or visit"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ action: "ASSIGN", technician: name, plannedDate: date, note });
        }}
      >
        <FormField name="technician" label="Technician or staff member" required value={name} onChange={setName} error={fieldErrors.technician} />
        <FormField name="plannedDate" label="Planned visit" type="date" min={today} value={date} onChange={setDate} error={fieldErrors.plannedDate} />
        <FormField name="note" label="Note for the customer" multiline value={note} onChange={setNote} error={fieldErrors.note} />
        <FormError message={error} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" className="h-12 text-base" disabled={busy}>
            {busy ? "Saving…" : first ? "Assign" : "Save"}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" className="h-12 text-base" onClick={onCancel}>
              Back
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

function ResolveForm({
  type,
  hasCharge,
  hasDiscount,
  chargeAllowed,
  busy,
  error,
  fieldErrors,
  onSubmit,
}: {
  type: ServiceType;
  hasCharge: boolean;
  hasDiscount: boolean;
  chargeAllowed: boolean;
  busy: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  onSubmit: (input: OwnerStepForm) => void;
}) {
  const [workDone, setWorkDone] = useState("");
  const [partsUsed, setPartsUsed] = useState("");
  const [cost, setCost] = useState("");
  const [charge, setCharge] = useState(false);
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeDescription, setChargeDescription] = useState("");
  const [discount, setDiscount] = useState(false);
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountDescription, setDiscountDescription] = useState("");
  const [note, setNote] = useState("");
  const chargeCents = rupeesToCents(chargeAmount);
  const discountCents = rupeesToCents(discountAmount);
  return (
    <Panel title="Resolve">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            action: "RESOLVE",
            workDone,
            partsUsed,
            cost,
            chargeAmount: charge ? chargeAmount : "",
            chargeDescription: charge ? chargeDescription : "",
            discountAmount: discount ? discountAmount : "",
            discountDescription: discount ? discountDescription : "",
            note,
          });
        }}
      >
        <FormField name="workDone" label="Work done" required multiline value={workDone} onChange={setWorkDone} error={fieldErrors.workDone} />
        <FormField name="partsUsed" label="Parts used" value={partsUsed} onChange={setPartsUsed} error={fieldErrors.partsUsed} />
        <FormField name="cost" label="Cost to you" prefix="Rs." inputMode="decimal" value={cost} onChange={setCost} error={fieldErrors.cost} hint="Your own cost, for your reports. The customer does not see it." />

        {!hasCharge && chargeAllowed && (
          <label className="flex min-h-12 items-center gap-3 rounded-lg border px-3">
            <input type="checkbox" className="size-5" checked={charge} onChange={(e) => setCharge(e.target.checked)} />
            <span className="text-base">Charge the customer on the next bill</span>
          </label>
        )}
        {charge && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <FormField name="chargeAmount" label="Charge" required prefix="Rs." inputMode="decimal" value={chargeAmount} onChange={setChargeAmount} error={fieldErrors.chargeAmount} />
            <FormField
              name="chargeDescription"
              label="Shown on the bill as"
              required
              value={chargeDescription}
              onChange={setChargeDescription}
              error={fieldErrors.chargeDescription}
              hint={chargeCents ? `${formatRupees(chargeCents)} is added to the next bill of this machine.` : "For example: drum unit (damaged)"}
            />
          </div>
        )}
        {type === "BREAKDOWN" && !hasDiscount && (
          <label className="flex min-h-12 items-center gap-3 rounded-lg border px-3">
            <input type="checkbox" className="size-5" checked={discount} onChange={(e) => setDiscount(e.target.checked)} />
            <span className="text-base">Give a discount for the time it was down</span>
          </label>
        )}
        {discount && (
          <div className="space-y-3 rounded-lg bg-muted/50 p-3">
            <FormField name="discountAmount" label="Discount" required prefix="Rs." inputMode="decimal" value={discountAmount} onChange={setDiscountAmount} error={fieldErrors.discountAmount} />
            <FormField
              name="discountDescription"
              label="Reason"
              required
              value={discountDescription}
              onChange={setDiscountDescription}
              error={fieldErrors.discountDescription}
              hint={discountCents ? `${formatRupees(discountCents)} becomes a credit, taken off the customer's next bills.` : "For example: machine down for 3 days"}
            />
          </div>
        )}
        <FormField name="note" label="Note for the customer" multiline value={note} onChange={setNote} error={fieldErrors.note} />
        <FormError message={error} />
        <Button type="submit" className="h-12 w-full text-base sm:w-auto" disabled={busy}>
          {busy ? "Saving…" : "Mark as resolved"}
        </Button>
      </form>
    </Panel>
  );
}
