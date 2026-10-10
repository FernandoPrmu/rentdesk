"use client";

import { useState } from "react";

import { Section } from "@/components/agreements/agreement-fields";
import { SettlementFields } from "@/components/agreements/deposit-fields";
import { FormField } from "@/components/forms/form-field";
import { addDays } from "@/lib/agreements/cycle-calendar";
import { BillingError } from "@/lib/billing/errors";
import { buildReturnInvoice, type ReturnContext } from "@/lib/billing/return-invoice";
import { formatCount, formatDate } from "@/lib/format";
import type { MachineType } from "@/lib/machines/schemas";
import { formatRupees } from "@/lib/money";
import { INVOICE_STATUS_LABEL } from "@/lib/status-labels";

type Errors = Record<string, string>;

/** Everything the return form needs, loaded by the page (serialisable). */
export interface ReturnFormData {
  type: MachineType;
  today: string;
  /** One per form: a retried submit (double tap, lost connection) is replayed, not repeated. */
  idempotencyKey: string;
  lastReadings: { bw: number; colour: number | null };
  /** The billing engine runs in the browser for the preview; the server recalculates on submit. */
  context: ReturnContext;
  deposit: {
    heldCents: number;
    invoices: { id: string; invoiceNo: string | null; status: string; balanceCents: number; deductible: boolean }[];
  };
}

function parseReading(text: string): number | null {
  const cleaned = text.trim().replace(/[,\s]/g, "");
  return /^\d{1,12}$/.test(cleaned) ? Number(cleaned) : null;
}

function Radio({ name, value, checked, onChange, label, hint }: { name: string; value: string; checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 has-checked:border-primary has-checked:bg-primary/5">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-0.5 size-5 accent-primary" />
      <span>
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-sm text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Return (MAC-04, RET-01): closing readings and reason, the final invoice
 * (prorated by the real days of the cycle, or the full month), the customer's
 * credits (applied unless unticked, rule 13) and the security deposit (settle now
 * or keep holding, DEP-03). Unpaid invoices do not block a return; they stay on
 * the customer's account.
 */
export function ReturnFields({ data, errors }: { data: ReturnFormData; errors: Errors }) {
  const { context, deposit, today } = data;
  const [bw, setBw] = useState("");
  const [colour, setColour] = useState("");
  const [rule, setRule] = useState<"PRORATED" | "FULL">("PRORATED");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [depositAction, setDepositAction] = useState<"SETTLE" | "HOLD">("SETTLE");

  const closingBw = parseReading(bw);
  const closingColour = data.type === "COLOUR" ? parseReading(colour) : null;
  const ready = closingBw !== null && (data.type === "MONO" || closingColour !== null);

  let preview: ReturnType<typeof buildReturnInvoice> = null;
  let previewError: string | null = null;
  if (ready && context.final.billable) {
    try {
      preview = buildReturnInvoice(context, { closing: { BW: closingBw, COLOUR: closingColour }, rule, creditsExcluded: excluded });
    } catch (e) {
      if (!(e instanceof BillingError)) throw e;
      previewError = e.message;
    }
  }

  const finalTotal = preview?.invoice.total_cents ?? 0;
  const unpaidCents = deposit.invoices.reduce((s, i) => s + i.balanceCents, 0) + finalTotal;
  const deductibleCents = deposit.invoices.filter((i) => i.deductible).reduce((s, i) => s + i.balanceCents, 0) + finalTotal;
  const { final } = context;

  return (
    <div className="space-y-6">
      <input type="hidden" name="idempotency_key" value={data.idempotencyKey} />
      <Section title="Closing meter readings">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="closing_bw"
            label="Closing B&W reading"
            inputMode="numeric"
            required
            value={bw}
            onChange={setBw}
            error={errors.closing_bw}
            hint={`Last known: ${formatCount(data.lastReadings.bw)}`}
          />
          {data.type === "COLOUR" && (
            <FormField
              name="closing_colour"
              label="Closing colour reading"
              inputMode="numeric"
              required
              value={colour}
              onChange={setColour}
              error={errors.closing_colour}
              hint={data.lastReadings.colour !== null ? `Last known: ${formatCount(data.lastReadings.colour)}` : undefined}
            />
          )}
        </div>
        <FormField name="reason" label="Reason for the return" multiline required error={errors.reason} />
      </Section>

      <Section title="Final invoice">
        {!final.billable ? (
          <p className="text-sm">Nothing is billed: the machine is returned before its first billing period starts.</p>
        ) : (
          <>
            <div className="grid gap-2" role="radiogroup" aria-label="Final cycle">
              <Radio
                name="rule"
                value="PRORATED"
                checked={rule === "PRORATED"}
                onChange={() => setRule("PRORATED")}
                label={`Prorated: ${final.daysUsed} of ${final.daysInCycle} days`}
                hint={`From ${formatDate(final.periodStart)} to today, the return day included.`}
              />
              <Radio name="rule" value="FULL" checked={rule === "FULL"} onChange={() => setRule("FULL")} label="Full month" hint="The last cycle is billed in full." />
            </div>
            {final.fullCycles > 0 && (
              <p className="text-sm">
                Also billed: {final.fullCycles} earlier month{final.fullCycles === 1 ? "" : "s"} without a confirmed reading (their open meter
                requests are closed).
              </p>
            )}
            {context.credits.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Customer credits (taken off this invoice unless you untick them)</p>
                <input type="hidden" name="credit_ids" value={context.credits.map((c) => c.id).join(",")} />
                {context.credits.map((c) => (
                  <label key={c.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3">
                    <input
                      type="checkbox"
                      name={`credit_${c.id}`}
                      checked={!excluded.includes(c.id)}
                      onChange={(e) => setExcluded((x) => (e.target.checked ? x.filter((id) => id !== c.id) : [...x, c.id]))}
                      className="size-5 accent-primary"
                    />
                    <span>
                      {c.label ? c.label[0].toUpperCase() + c.label.slice(1) : "Credit"}: {formatRupees(c.amountCents)} available
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="rounded-xl border bg-muted/30 p-3 text-sm" data-testid="final-invoice-preview" aria-live="polite">
              {!ready ? (
                <p className="text-muted-foreground">Enter the closing reading{data.type === "COLOUR" ? "s" : ""} to see the final invoice.</p>
              ) : previewError ? (
                <p className="text-destructive">{previewError}</p>
              ) : preview ? (
                <>
                  <ul className="space-y-1">
                    {preview.invoice.lines.map((l, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span>{l.description}</span>
                        <span className="shrink-0 tabular-nums">{formatRupees(l.amount_cents)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 flex justify-between gap-3 border-t pt-2 font-semibold">
                    <span>Final invoice</span>
                    <span data-testid="final-invoice-total">{formatRupees(preview.invoice.total_cents)}</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">Issued at once, due {formatDate(addDays(today, context.dueDays))}.</p>
                </>
              ) : null}
            </div>
          </>
        )}
      </Section>

      <Section title="Balance and deposit">
        {deposit.invoices.length > 0 && (
          <ul className="space-y-1 text-sm">
            {deposit.invoices.map((i) => (
              <li key={i.id} className="flex justify-between gap-3">
                <span>
                  {i.invoiceNo ?? "Invoice"} · {INVOICE_STATUS_LABEL[i.status] ?? i.status}
                  {!i.deductible && " (not paid from the deposit)"}
                </span>
                <span className="shrink-0 tabular-nums">{formatRupees(i.balanceCents)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Unpaid balance{finalTotal > 0 ? " (with the final invoice)" : ""}</dt>
          <dd className="text-right font-semibold" data-testid="return-unpaid">
            {formatRupees(unpaidCents)}
          </dd>
          <dt className="text-muted-foreground">Deposit held</dt>
          <dd className="text-right font-semibold" data-testid="return-deposit-held">
            {formatRupees(deposit.heldCents)}
          </dd>
        </dl>
        <p className="text-sm text-muted-foreground">Unpaid bills stay on the customer&apos;s account; they can still sign in and pay.</p>
        {deposit.heldCents > 0 && (
          <>
            <div className="grid gap-2" role="radiogroup" aria-label="Deposit">
              <Radio name="deposit_action" value="SETTLE" checked={depositAction === "SETTLE"} onChange={() => setDepositAction("SETTLE")} label="Settle the deposit now" />
              <Radio
                name="deposit_action"
                value="HOLD"
                checked={depositAction === "HOLD"}
                onChange={() => setDepositAction("HOLD")}
                label="Keep holding it, settle later"
                hint="It stays on the agreement and under “Deposits to settle”."
              />
            </div>
            {depositAction === "SETTLE" && <SettlementFields heldCents={deposit.heldCents} deductibleCents={deductibleCents} today={today} errors={errors} />}
          </>
        )}
      </Section>
    </div>
  );
}
