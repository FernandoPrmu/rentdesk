"use client";

import { useState } from "react";
import { toast } from "sonner";

import { FormError, FormField, SelectField } from "@/components/forms/form-field";
import { type FormAction, useFormAction } from "@/components/forms/use-form-action";
import { Button } from "@/components/ui/button";

/**
 * Settings editor (ADM-06, decision 82): the admin's platform defaults, or an
 * owner's overrides where each value can follow the platform default. The server
 * parses and checks every value again (Zod, then the database).
 */

export interface SettingInput {
  key: string;
  label: string;
  help?: string;
  kind: "int" | "list" | "bool" | "money" | "weekday";
  unit?: string;
  /** The value as the form shows it ("2, 4", "500", "on"). */
  value: string;
  /** Owners: the platform default, as text, and whether the owner follows it now. */
  platform?: string;
  inherited?: boolean;
}

export interface SettingGroupInput {
  title: string;
  fields: SettingInput[];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, i) => ({ value: String(i), label }));

function Field({ field, error, owner }: { field: SettingInput; error?: string; owner: boolean }) {
  const [inherit, setInherit] = useState(!!field.inherited);
  const [checked, setChecked] = useState(field.value === "on");
  const disabled = owner && inherit;
  const hint = [field.help, field.kind === "list" ? "Separate numbers with commas." : null, owner ? `Platform default: ${field.platform}.` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid={`setting-${field.key}`}>
      {field.kind === "bool" ? (
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input type="checkbox" name={field.key} checked={checked} disabled={disabled} onChange={(e) => setChecked(e.target.checked)} className="size-5 accent-primary" />
          <span className="font-medium">{field.label}</span>
        </label>
      ) : field.kind === "weekday" ? (
        <SelectField name={field.key} label={field.label} options={WEEKDAYS} defaultValue={field.value} required error={error} hint={hint || undefined} />
      ) : (
        <FormField
          name={field.key}
          label={field.unit && field.kind !== "money" ? `${field.label} (${field.unit})` : field.label}
          prefix={field.kind === "money" ? "Rs." : undefined}
          inputMode={field.kind === "money" ? "decimal" : field.kind === "list" ? "text" : "numeric"}
          required
          defaultValue={field.value}
          error={error}
          hint={hint || undefined}
          disabled={disabled}
        />
      )}
      {field.kind === "bool" && (hint || error) && (
        <>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </>
      )}
      {owner && (
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" name={`default:${field.key}`} checked={inherit} onChange={(e) => setInherit(e.target.checked)} className="size-5 accent-primary" />
          Use the platform default
        </label>
      )}
    </div>
  );
}

export function SettingsForm({ groups, action, mode, testId }: { groups: SettingGroupInput[]; action: FormAction<{ changed: string[] }>; mode: "platform" | "owner"; testId?: string }) {
  const { onSubmit, pending, errors, formError } = useFormAction(action, (data) =>
    toast.success(data.changed.length === 0 ? "Nothing changed" : `Saved (${data.changed.length} ${data.changed.length === 1 ? "change" : "changes"})`),
  );
  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate data-testid={testId}>
      {groups.map((g) => (
        <fieldset key={g.title} className="space-y-3">
          <legend className="mb-2 text-lg font-semibold">{g.title}</legend>
          {g.fields.map((f) => (
            <Field key={f.key} field={f} error={errors[f.key]} owner={mode === "owner"} />
          ))}
        </fieldset>
      ))}
      <FormError message={formError} />
      <div className="sticky bottom-20 z-10 md:bottom-4">
        <Button type="submit" disabled={pending} className="h-12 w-full text-base shadow-lg sm:w-auto sm:px-8">
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
