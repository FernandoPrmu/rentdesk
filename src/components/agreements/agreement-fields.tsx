"use client";

import { useState } from "react";

import { FormField, SelectField } from "@/components/forms/form-field";
import { addDays, defaultFirstBillingDate, isIsoDate } from "@/lib/agreements/cycle-calendar";
import { DEFAULT_CYCLE_LENGTH, DEFAULT_DUE_DAYS } from "@/lib/agreements/schemas";
import { formatCount, formatDate } from "@/lib/format";
import type { MachineType } from "@/lib/machines/schemas";

type Errors = Record<string, string>;

export interface TermsDefaults {
  monthly_commitment: string;
  bw_included: string;
  bw_rate: string;
  colour_included: string;
  colour_rate: string;
  due_days: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-3 text-base font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Commitment, included copies and excess rates per counter (AGR-01). Money in rupees. */
export function TermsFields({ type, defaults, errors }: { type: MachineType; defaults?: TermsDefaults; errors: Errors }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="monthly_commitment"
          label="Monthly commitment"
          prefix="Rs."
          inputMode="decimal"
          required
          defaultValue={defaults?.monthly_commitment}
          error={errors.monthly_commitment}
          hint="Charged every cycle, even with low usage."
        />
        <FormField
          name="due_days"
          label="Days to pay"
          inputMode="numeric"
          required
          defaultValue={defaults?.due_days ?? String(DEFAULT_DUE_DAYS)}
          error={errors.due_days}
          hint="Days after the invoice is confirmed."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="bw_included"
          label="Included B&W copies"
          inputMode="numeric"
          required
          defaultValue={defaults?.bw_included}
          error={errors.bw_included}
        />
        <FormField
          name="bw_rate"
          label="B&W excess rate (per copy)"
          prefix="Rs."
          inputMode="decimal"
          required
          defaultValue={defaults?.bw_rate}
          error={errors.bw_rate}
        />
      </div>
      {type === "COLOUR" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="colour_included"
            label="Included colour copies"
            inputMode="numeric"
            required
            defaultValue={defaults?.colour_included}
            error={errors.colour_included}
          />
          <FormField
            name="colour_rate"
            label="Colour excess rate (per copy)"
            prefix="Rs."
            inputMode="decimal"
            required
            defaultValue={defaults?.colour_rate}
            error={errors.colour_rate}
          />
        </div>
      )}
    </>
  );
}

/**
 * Customer, dates, location, initial meter readings and terms for a new agreement
 * (MAC-02, AGR-01). The first billing date is suggested from the start date (one
 * cycle later, never in the past) and shown clearly; the owner can change it.
 */
export function AssignmentFields({
  type,
  today,
  customers,
  fixedCustomer,
  errors,
}: {
  type: MachineType;
  today: string;
  customers?: { id: string; name: string }[];
  fixedCustomer?: { id: string; name: string };
  errors: Errors;
}) {
  const [startDate, setStartDate] = useState(today);
  const [cycleLength, setCycleLength] = useState(String(DEFAULT_CYCLE_LENGTH));
  const [firstBilling, setFirstBilling] = useState(defaultFirstBillingDate(today, DEFAULT_CYCLE_LENGTH, today));
  const [firstTouched, setFirstTouched] = useState(false);

  const length = Number(cycleLength);
  const lengthOk = Number.isInteger(length) && length >= 7 && length <= 366;

  function suggest(start: string, len: string) {
    const n = Number(len);
    if (!firstTouched && isIsoDate(start) && Number.isInteger(n) && n >= 7 && n <= 366) {
      setFirstBilling(defaultFirstBillingDate(start, n, today));
    }
  }

  const firstOk = isIsoDate(firstBilling) && firstBilling >= today && (!isIsoDate(startDate) || firstBilling > startDate);

  return (
    <div className="space-y-6">
      <Section title="Customer">
        {fixedCustomer ? (
          <>
            <input type="hidden" name="customer_id" value={fixedCustomer.id} />
            <p className="text-base font-medium">{fixedCustomer.name}</p>
          </>
        ) : (
          <SelectField
            name="customer_id"
            label="Customer"
            required
            placeholder="Choose a customer…"
            options={(customers ?? []).map((c) => ({ value: c.id, label: c.name }))}
            error={errors.customer_id}
            hint={customers && customers.length === 0 ? "You have no active customers. Create one first." : undefined}
          />
        )}
        <FormField
          name="installation_location"
          label="Installation location"
          required
          error={errors.installation_location}
          hint="Where the machine stands, e.g. “Ground floor, front office”."
        />
      </Section>

      <Section title="Dates">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="start_date"
            label="Start date"
            type="date"
            required
            value={startDate}
            onChange={(v) => {
              setStartDate(v);
              suggest(v, cycleLength);
            }}
            error={errors.start_date}
            hint="Can be in the past for a rental that is already running."
          />
          <FormField
            name="cycle_length_days"
            label="Cycle length (days)"
            inputMode="numeric"
            required
            value={cycleLength}
            onChange={(v) => {
              setCycleLength(v);
              suggest(startDate, v);
            }}
            error={errors.cycle_length_days}
          />
        </div>
        <FormField
          name="first_billing_date"
          label="First billing date"
          type="date"
          required
          min={today}
          value={firstBilling}
          onChange={(v) => {
            setFirstBilling(v);
            setFirstTouched(true);
          }}
          error={errors.first_billing_date}
          hint="The day the first meter reading is requested. Today or later."
        />
        {firstOk && lengthOk && (
          <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm" data-testid="first-billing-preview">
            First meter reading request on <strong>{formatDate(firstBilling)}</strong>, then every {length} days (next:{" "}
            {formatDate(addDays(firstBilling, length))}).
          </p>
        )}
        <FormField name="end_date" label="End date" type="date" error={errors.end_date} hint="Leave empty for an open-ended rental." />
      </Section>

      <Section title="Meter readings now">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="initial_bw" label="B&W counter" inputMode="numeric" required error={errors.initial_bw} />
          {type === "COLOUR" && (
            <FormField name="initial_colour" label="Colour counter" inputMode="numeric" required error={errors.initial_colour} />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Read the {type === "COLOUR" ? "B&W and colour counters" : "B&W counter"}, not the total. The first invoice counts copies from these numbers.
        </p>
      </Section>

      <Section title="Pricing">
        <TermsFields type={type} errors={errors} />
      </Section>
    </div>
  );
}

/** Closing meter readings and the reason for a return (MAC-04). */
export function ReturnFields({
  type,
  lastReadings,
  errors,
}: {
  type: MachineType;
  lastReadings: { bw: number; colour: number | null };
  errors: Errors;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="closing_bw"
          label="Closing B&W reading"
          inputMode="numeric"
          required
          error={errors.closing_bw}
          hint={`Last known: ${formatCount(lastReadings.bw)}`}
        />
        {type === "COLOUR" && (
          <FormField
            name="closing_colour"
            label="Closing colour reading"
            inputMode="numeric"
            required
            error={errors.closing_colour}
            hint={lastReadings.colour !== null ? `Last known: ${formatCount(lastReadings.colour)}` : undefined}
          />
        )}
      </div>
      <FormField name="reason" label="Reason for the return" multiline required error={errors.reason} />
    </div>
  );
}
