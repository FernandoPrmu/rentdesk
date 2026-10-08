import type { ChangeEvent, ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
}

function FieldShell({
  id,
  label,
  required,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
        {!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Label + large input + inline error, wired up for screen readers. */
export function FormField({
  name,
  label,
  type = "text",
  required,
  autoComplete,
  multiline,
  defaultValue,
  value,
  onChange,
  error,
  hint,
  inputMode,
  min,
  max,
  prefix,
}: {
  name: string;
  label: string;
  type?: "text" | "email" | "tel" | "password" | "date";
  required?: boolean;
  autoComplete?: string;
  multiline?: boolean;
  defaultValue?: string;
  /** Controlled value (with onChange); otherwise the field is uncontrolled. */
  value?: string;
  onChange?: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  inputMode?: "numeric" | "decimal" | "text";
  min?: string;
  max?: string;
  /** Short text shown inside the box on the left, e.g. "Rs.". */
  prefix?: string;
}) {
  const id = `field-${name}`;
  const common = {
    id,
    name,
    ...(value !== undefined ? { value } : { defaultValue }),
    onChange: onChange ? (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value) : undefined,
    required,
    autoComplete,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy(id, error, hint),
  };
  return (
    <FieldShell id={id} label={label} required={required} error={error} hint={hint}>
      {multiline ? (
        <Textarea {...common} rows={2} className="min-h-12 text-base" />
      ) : prefix ? (
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-muted-foreground" aria-hidden>
            {prefix}
          </span>
          <Input {...common} type={type} inputMode={inputMode} min={min} max={max} className="h-12 pl-11 text-base" />
        </div>
      ) : (
        <Input {...common} type={type} inputMode={inputMode} min={min} max={max} className="h-12 text-base" />
      )}
    </FieldShell>
  );
}

/** Native select (large, works everywhere) with the same label and error layout. */
export function SelectField({
  name,
  label,
  options,
  required,
  defaultValue,
  value,
  onChange,
  error,
  hint,
  placeholder,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  required?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const id = `field-${name}`;
  return (
    <FieldShell id={id} label={label} required={required} error={error} hint={hint}>
      <select
        id={id}
        name={name}
        {...(value !== undefined ? { value } : { defaultValue: defaultValue ?? "" })}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base"
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/** Form-level error under the fields. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}
