"use client";

import { Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FormError, SelectField } from "@/components/forms/form-field";
import { type FormAction, useFormAction } from "@/components/forms/use-form-action";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MACHINE_STATUS_LABEL, MANUAL_MACHINE_STATUSES, type MachineStatus } from "@/lib/machines/schemas";

function StatusForm({ status, action, onDone }: { status: MachineStatus; action: FormAction; onDone: () => void }) {
  const { onSubmit, pending, errors, formError } = useFormAction(action, () => {
    toast.success("Machine status changed");
    onDone();
  });
  const options = MANUAL_MACHINE_STATUSES.filter((s) => s !== status).map((s) => ({ value: s, label: MACHINE_STATUS_LABEL[s] }));
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <AlertDialogHeader>
        <AlertDialogTitle>Change machine status</AlertDialogTitle>
        <AlertDialogDescription>
          Now: {MACHINE_STATUS_LABEL[status]}. &ldquo;Rented&rdquo; is set by assigning the machine to a customer.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <SelectField name="status" label="New status" required options={options} defaultValue={options[0]?.value} error={errors.status} />
      <div className="space-y-1.5">
        <Label htmlFor="machine-status-reason">Reason</Label>
        <Textarea id="machine-status-reason" name="reason" required minLength={3} rows={3} className="text-base" />
        {errors.reason && <p className="text-sm text-destructive">{errors.reason}</p>}
      </div>
      <FormError message={errors.reason ? null : formError} />
      <AlertDialogFooter>
        <AlertDialogCancel className="h-11" disabled={pending}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" className="h-11" disabled={pending}>
          {pending ? "Saving…" : "Change status"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

/** MAC-03: available / under repair / retired, with a reason (audited). */
export function MachineStatusButton({ status, action }: { status: MachineStatus; action: FormAction }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" className="h-12 gap-2 text-base" onClick={() => setOpen(true)}>
        <Wrench className="size-5" aria-hidden />
        Change status
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>{open && <StatusForm status={status} action={action} onDone={() => setOpen(false)} />}</AlertDialogContent>
      </AlertDialog>
    </>
  );
}
