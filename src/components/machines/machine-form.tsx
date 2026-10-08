"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { FormError, FormField, SelectField } from "@/components/forms/form-field";
import { type FormAction, useFormAction } from "@/components/forms/use-form-action";
import { Button } from "@/components/ui/button";
import { MACHINE_TYPE_LABEL, MACHINE_TYPES, type MachineType } from "@/lib/machines/schemas";

export interface MachineDefaults {
  brand: string;
  model: string;
  serial_no: string;
  type: MachineType;
  purchase_date: string | null;
  bw_counter_max: number | null;
  colour_counter_max: number | null;
  notes: string | null;
}

/**
 * Register (MAC-01) or edit a machine. The type is chosen once: it decides the
 * meter readings and the billing terms, so it cannot change later.
 */
export function MachineForm(
  props:
    | { mode: "create"; action: FormAction<{ id: string }> }
    | { mode: "edit"; action: FormAction; defaults: MachineDefaults; backHref: string },
) {
  const router = useRouter();
  const defaults = props.mode === "edit" ? props.defaults : null;
  const [type, setType] = useState<MachineType | "">(defaults?.type ?? "");
  const { onSubmit, pending, errors, formError } = useFormAction(props.action as FormAction<{ id: string } | undefined>, (data) => {
    if (props.mode === "create" && data) {
      toast.success("Machine registered");
      router.push(`/owner/machines/${data.id}`);
    } else {
      toast.success("Changes saved");
      if (props.mode === "edit") router.push(props.backHref);
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="brand" label="Brand" required defaultValue={defaults?.brand} error={errors.brand} />
        <FormField name="model" label="Model" required defaultValue={defaults?.model} error={errors.model} />
      </div>
      <FormField name="serial_no" label="Serial number" required defaultValue={defaults?.serial_no} error={errors.serial_no} />
      {props.mode === "create" ? (
        <SelectField
          name="type"
          label="Type"
          required
          value={type}
          onChange={(v) => setType(v as MachineType | "")}
          placeholder="Choose…"
          options={MACHINE_TYPES.map((t) => ({ value: t, label: MACHINE_TYPE_LABEL[t] }))}
          error={errors.type}
          hint="Mono machines have one B&W counter; colour machines have B&W and colour counters. This cannot be changed later."
        />
      ) : (
        <p className="text-sm">
          <span className="text-muted-foreground">Type:</span> {MACHINE_TYPE_LABEL[props.defaults.type]}
        </p>
      )}
      <FormField name="purchase_date" label="Purchase date" type="date" defaultValue={defaults?.purchase_date ?? ""} error={errors.purchase_date} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="bw_counter_max"
          label="B&W counter maximum"
          inputMode="numeric"
          defaultValue={defaults?.bw_counter_max?.toString() ?? ""}
          error={errors.bw_counter_max}
          hint="Highest number the counter shows before it rolls over to 0, e.g. 999999."
        />
        {type === "COLOUR" && (
          <FormField
            name="colour_counter_max"
            label="Colour counter maximum"
            inputMode="numeric"
            defaultValue={defaults?.colour_counter_max?.toString() ?? ""}
            error={errors.colour_counter_max}
          />
        )}
      </div>
      <FormField name="notes" label="Notes" multiline defaultValue={defaults?.notes ?? ""} error={errors.notes} />
      <FormError message={formError} />
      <Button type="submit" disabled={pending} className="h-12 w-full text-base sm:w-auto sm:px-8">
        {pending ? "Saving…" : props.mode === "create" ? "Register machine" : "Save changes"}
      </Button>
    </form>
  );
}
