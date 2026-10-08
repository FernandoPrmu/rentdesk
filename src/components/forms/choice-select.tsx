"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * shadcn Select (Base UI) sized for touch: a full-width 48 px trigger and 48 px
 * options. The popup is anchored below the trigger (not over it), takes the
 * trigger's width and is kept inside the viewport by collision handling, so it
 * fits a 360 px screen. `name` submits the value through Base UI's hidden input,
 * so it works in Server Action forms and in plain GET filter forms. An empty
 * value ("" or the `emptyLabel` item) is submitted as "".
 */
export function ChoiceSelect({
  id,
  name,
  options,
  defaultValue,
  value,
  onChange,
  placeholder,
  emptyLabel,
  required,
  invalid,
  describedBy,
  ariaLabel,
  triggerClassName,
}: {
  id?: string;
  name: string;
  options: ChoiceOption[];
  defaultValue?: string;
  /** Controlled value (with onChange); otherwise uncontrolled. */
  value?: string;
  onChange?: (value: string) => void;
  /** Shown when nothing is chosen. */
  placeholder?: string;
  /** Adds a first option that clears the choice, e.g. "All types". */
  emptyLabel?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Accessible name when there is no visible <label for={id}>. */
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  const items = [...(emptyLabel ? [{ value: null, label: emptyLabel }] : []), ...options];
  const toValue = (v: string | undefined) => (v === undefined ? undefined : v === "" ? null : v);
  return (
    <Select
      name={name}
      items={items}
      required={required}
      {...(value !== undefined ? { value: toValue(value) } : { defaultValue: toValue(defaultValue) ?? null })}
      onValueChange={onChange ? (v) => onChange((v as string | null) ?? "") : undefined}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={cn("h-12 w-full px-3 text-base data-[size=default]:h-12", triggerClassName)}
      >
        <SelectValue placeholder={placeholder ?? emptyLabel} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="max-w-[calc(100vw-2rem)]">
        {items.map((o) => (
          <SelectItem key={o.value ?? "__empty"} value={o.value} className="min-h-12 py-3 pl-3 text-base">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
