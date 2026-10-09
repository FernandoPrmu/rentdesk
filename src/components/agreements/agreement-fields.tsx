"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { FormField, SelectField } from "@/components/forms/form-field";
import { Button } from "@/components/ui/button";
import { billingDayText, cycleDate, defaultFirstBillingDate, isIsoDate } from "@/lib/agreements/cycle-calendar";
import { DEFAULT_DUE_DAYS, LATE_FEE_MODES, type LateFeeMode, MAX_UPFRONT_ENTRIES, PAYMENT_METHODS, UPFRONT_TYPES } from "@/lib/agreements/schemas";
import { formatDate } from "@/lib/format";
import type { MachineType } from "@/lib/machines/schemas";
import { LATE_FEE_MODE_LABEL, PAYMENT_METHOD_LABEL, UPFRONT_TYPE_LABEL } from "@/lib/status-labels";

type Errors = Record<string, string>;

export interface TermsDefaults {
  monthly_commitment: string;
  bw_included: string;
  bw_rate: string;
  colour_included: string;
  colour_rate: string;
  due_days: string;
  late_fee_mode: LateFeeMode;
  late_fee: string;
}

export function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-1 text-base font-semibold">{title}</legend>
      {hint && <p className="-mt-1 text-sm text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

export const methodOptions = PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }));

/** LATE-01: owner default, a custom amount, or none for this agreement. */
function LateFeeFields({ defaults, ownerDefault, errors }: { defaults?: TermsDefaults; ownerDefault: string; errors: Errors }) {
  const [mode, setMode] = useState<string>(defaults?.late_fee_mode ?? "OWNER_DEFAULT");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SelectField
        name="late_fee_mode"
        label="Late fee"
        required
        value={mode}
        onChange={setMode}
        options={LATE_FEE_MODES.map((m) => ({ value: m, label: LATE_FEE_MODE_LABEL[m] }))}
        error={errors.late_fee_mode}
        hint={mode === "OWNER_DEFAULT" ? `Your default: ${ownerDefault}` : mode === "NONE" ? "Never charged on this agreement." : "Charged once per unpaid invoice after the grace period."}
      />
      {mode === "CUSTOM" && (
        <FormField name="late_fee" label="Late fee amount" prefix="Rs." inputMode="decimal" required defaultValue={defaults?.late_fee} error={errors.late_fee} />
      )}
    </div>
  );
}

/** Commitment, included copies, excess rates per counter, days to pay, late fee (AGR-01, LATE-01). Money in rupees. */
export function TermsFields({
  type,
  defaults,
  ownerLateFee,
  errors,
}: {
  type: MachineType;
  defaults?: TermsDefaults;
  ownerLateFee: string;
  errors: Errors;
}) {
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
          hint="Charged every month, even with low usage."
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
        <FormField name="bw_included" label="Included B&W copies" inputMode="numeric" required defaultValue={defaults?.bw_included} error={errors.bw_included} />
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
      <LateFeeFields defaults={defaults} ownerDefault={ownerLateFee} errors={errors} />
    </>
  );
}

/**
 * DEP-01/02 "Money received upfront": several rows, each a security deposit (held,
 * never applied to bills) or an advance payment (a credit for the next invoices).
 */
function UpfrontMoneyFields({ today, errors }: { today: string; errors: Errors }) {
  // Row numbers only grow, so input names stay stable when a row is removed.
  const [rows, setRows] = useState<number[]>([]);
  const [types, setTypes] = useState<Record<number, string>>({});
  const next = rows.length === 0 ? 0 : Math.max(...rows) + 1;

  return (
    <Section title="Money received upfront" hint="Optional. A security deposit is held until the machine comes back; an advance payment is taken off the next bills.">
      {rows.map((n, index) => {
        const type = types[n] ?? "SECURITY_DEPOSIT";
        const e = (f: string) => errors[`upfront_${n}_${f}`];
        return (
          <div key={n} className="space-y-4 rounded-xl border p-3" data-testid="upfront-row">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Payment {index + 1}</p>
              <Button
                type="button"
                variant="ghost"
                className="h-11 gap-1"
                onClick={() => setRows((r) => r.filter((x) => x !== n))}
                aria-label={`Remove payment ${index + 1}`}
              >
                <Trash2 className="size-4" aria-hidden /> Remove
              </Button>
            </div>
            <SelectField
              name={`upfront_${n}_type`}
              label={`Type (payment ${index + 1})`}
              required
              value={type}
              onChange={(v) => setTypes((t) => ({ ...t, [n]: v }))}
              options={UPFRONT_TYPES.map((t) => ({ value: t, label: UPFRONT_TYPE_LABEL[t] }))}
              error={e("type")}
              hint={type === "SECURITY_DEPOSIT" ? "Held separately; never used for normal bills." : "Taken off the next invoices automatically."}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name={`upfront_${n}_amount`} label={`Amount (payment ${index + 1})`} prefix="Rs." inputMode="decimal" required error={e("amount")} />
              <FormField
                name={`upfront_${n}_received_on`}
                label={`Date received (payment ${index + 1})`}
                type="date"
                required
                max={today}
                defaultValue={today}
                error={e("received_on")}
                hint="Can be in the past for a rental already running."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                name={`upfront_${n}_method`}
                label={`Paid by (payment ${index + 1})`}
                required
                placeholder="Choose…"
                options={methodOptions}
                error={e("method")}
              />
              <FormField name={`upfront_${n}_reference`} label={`Reference (payment ${index + 1})`} error={e("reference")} />
            </div>
            <FormField name={`upfront_${n}_note`} label={`Note (payment ${index + 1})`} error={e("note")} />
          </div>
        );
      })}
      {errors.upfront && <p className="text-sm text-destructive">{errors.upfront}</p>}
      {rows.length < MAX_UPFRONT_ENTRIES && (
        <Button type="button" variant="outline" className="h-12 w-full gap-2 text-base sm:w-auto" onClick={() => setRows((r) => [...r, next])}>
          <Plus className="size-5" aria-hidden /> Add money received
        </Button>
      )}
    </Section>
  );
}

/**
 * Customer, dates, location, initial meter readings, terms and money received
 * upfront for a new agreement (MAC-02, AGR-01, DEP-01/02). The first billing date
 * is suggested one month after the start date (never in the past) and the next
 * dates are shown: monthly on that day, the last day in shorter months.
 */
export function AssignmentFields({
  type,
  today,
  customers,
  fixedCustomer,
  ownerLateFee,
  errors,
}: {
  type: MachineType;
  today: string;
  customers?: { id: string; name: string }[];
  fixedCustomer?: { id: string; name: string };
  ownerLateFee: string;
  errors: Errors;
}) {
  const [startDate, setStartDate] = useState(today);
  const [firstBilling, setFirstBilling] = useState(defaultFirstBillingDate(today, today));
  const [firstTouched, setFirstTouched] = useState(false);

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
        <FormField
          name="start_date"
          label="Start date"
          type="date"
          required
          value={startDate}
          onChange={(v) => {
            setStartDate(v);
            if (!firstTouched && isIsoDate(v)) setFirstBilling(defaultFirstBillingDate(v, today));
          }}
          error={errors.start_date}
          hint="Can be in the past for a rental that is already running."
        />
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
          hint="The day the first meter reading is requested. Today or later. Billing repeats monthly on this day."
        />
        {firstOk && (
          <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm" data-testid="first-billing-preview">
            First meter reading request on <strong>{formatDate(firstBilling)}</strong>. {billingDayText(firstBilling)}: next{" "}
            {formatDate(cycleDate(firstBilling, 2))}, then {formatDate(cycleDate(firstBilling, 3))}.
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
        <TermsFields type={type} ownerLateFee={ownerLateFee} errors={errors} />
      </Section>

      <UpfrontMoneyFields today={today} errors={errors} />
    </div>
  );
}
