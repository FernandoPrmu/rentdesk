import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Label + large input + inline error, wired up for screen readers. */
export function FormField({
  name,
  label,
  type = "text",
  required,
  autoComplete,
  multiline,
  defaultValue,
  error,
  hint,
  inputMode,
}: {
  name: string;
  label: string;
  type?: "text" | "email" | "tel" | "password";
  required?: boolean;
  autoComplete?: string;
  multiline?: boolean;
  defaultValue?: string;
  error?: string;
  hint?: string;
  inputMode?: "numeric" | "text";
}) {
  const id = `field-${name}`;
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    name,
    defaultValue,
    required,
    autoComplete,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
        {!required && <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      {multiline ? (
        <Textarea {...common} rows={2} className="min-h-12 text-base" />
      ) : (
        <Input {...common} type={type} inputMode={inputMode} className="h-12 text-base" />
      )}
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
