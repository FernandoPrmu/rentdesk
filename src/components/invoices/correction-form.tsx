"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { FormField } from "@/components/forms/form-field";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { formatCount } from "@/lib/format";
import { type AdjustmentInput, type CorrectionInput, type CorrectionView, previewCorrection } from "@/lib/invoices/correction-form";
import { formatRupees } from "@/lib/money";

/**
 * Correct an issued bill (11.1, 11.3, 11.4; decision 49): corrected reading(s)
 * and/or adjustment lines, the reason the customer sees and the due date. The bill
 * shown below is calculated as you type by the same billing engine as the server.
 * Saving cancels the old bill (its number is voided) and issues the corrected one
 * with a new number; money already paid is kept as credit and taken off it.
 */
export function CorrectionForm({ view, action }: { view: CorrectionView; action: (input: CorrectionInput) => Promise<ActionResult<{ invoiceNo: string; invoiceId: string }>> }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [bw, setBw] = useState("");
  const [colour, setColour] = useState("");
  const [adjustments, setAdjustments] = useState<AdjustmentInput[]>([]);
  const [reason, setReason] = useState("");
  const [dueDate, setDueDate] = useState(view.defaultDueDate);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const touched = bw.trim() !== "" || colour.trim() !== "" || adjustments.length > 0;
  const preview = useMemo(() => (touched ? previewCorrection(view, { bw, colour, adjustments }) : null), [view, bw, colour, adjustments, touched]);
  const errors = { ...(preview && !preview.ok ? preview.errors : {}), ...serverErrors };
  const clear = () => {
    setServerErrors({});
    setMessage(null);
  };
  const setAdjustment = (n: number, patch: Partial<AdjustmentInput>) => {
    setAdjustments(adjustments.map((a, i) => (i === n ? { ...a, ...patch } : a)));
    clear();
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        clear();
        start(async () => {
          const result = await action({ ticketId: view.ticket.id, invoiceId: view.invoice.id, reason, bw, colour, adjustments, dueDate });
          if (result.ok) {
            toast.success(`Corrected bill ${result.data.invoiceNo} issued. The customer was told.`);
            router.push(`/owner/tickets/${view.ticket.id}`);
            return;
          }
          setServerErrors(result.fieldErrors ?? {});
          setMessage(result.error);
        });
      }}
    >
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">1. Readings</h2>
        {view.readingsAllowed ? (
          view.counters.map((c) => {
            const key = c.counter === "BW" ? "bw" : "colour";
            return (
              <div key={c.counter} className="space-y-1.5">
                <Label htmlFor={`correct-${key}`} className="text-base">
                  {c.counter === "BW" ? (view.machineType === "COLOUR" ? "B&W counter" : "Meter reading") : "Colour counter"}
                </Label>
                <Input
                  id={`correct-${key}`}
                  inputMode="numeric"
                  className="h-12 text-lg"
                  placeholder={formatCount(c.current)}
                  value={key === "bw" ? bw : colour}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d,\s]/g, "");
                    if (key === "bw") setBw(v);
                    else setColour(v);
                    clear();
                  }}
                  aria-invalid={Boolean(errors[key])}
                />
                <p className="text-xs text-muted-foreground">
                  Billed: {formatCount(c.previous)} → {formatCount(c.current)}. Leave empty to keep it.
                </p>
                {errors[key] && <p className="text-sm text-destructive">{errors[key]}</p>}
              </div>
            );
          })
        ) : (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm" data-testid="readings-blocked">
            {view.readingsBlocked}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">2. Adjustment lines</h2>
        <p className="text-sm text-muted-foreground">For a calculation or rate error, or a charge that was missed.</p>
        {adjustments.map((a, n) => (
          <div key={n} className="space-y-2 rounded-xl border p-3" data-testid="adjustment">
            <div className="space-y-1.5">
              <Label htmlFor={`adj-${n}-description`}>Description (printed on the bill)</Label>
              <Input id={`adj-${n}-description`} className="h-11 text-base" value={a.description} maxLength={120} onChange={(e) => setAdjustment(n, { description: e.target.value })} />
            </div>
            <div className="grid grid-cols-[1fr_8rem] gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`adj-${n}-direction`}>Type</Label>
                <ChoiceSelect
                  id={`adj-${n}-direction`}
                  name={`adj-${n}-direction`}
                  value={a.direction}
                  onChange={(v) => setAdjustment(n, { direction: v as AdjustmentInput["direction"] })}
                  options={[
                    { value: "TAKE_OFF", label: "Take off the bill" },
                    { value: "ADD", label: "Add to the bill" },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`adj-${n}-amount`}>Rs.</Label>
                <Input id={`adj-${n}-amount`} inputMode="decimal" className="h-12 text-base" value={a.amount} onChange={(e) => setAdjustment(n, { amount: e.target.value })} />
              </div>
            </div>
            {errors[`adjustment${n}`] && <p className="text-sm text-destructive">{errors[`adjustment${n}`]}</p>}
            <Button type="button" variant="ghost" className="h-10 gap-1" onClick={() => setAdjustments(adjustments.filter((_, i) => i !== n))}>
              <Trash2 className="size-4" aria-hidden /> Remove line
            </Button>
          </div>
        ))}
        {adjustments.length < 5 && (
          <Button type="button" variant="outline" className="h-11 gap-2" onClick={() => setAdjustments([...adjustments, { description: "", direction: "TAKE_OFF", amount: "" }])}>
            <Plus className="size-4" aria-hidden /> Add a line
          </Button>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">3. The corrected bill</h2>
        {preview?.ok ? (
          <div className="rounded-xl border p-3 text-sm" data-testid="correction-preview">
            <ul className="divide-y">
              {preview.built.invoice.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-3 py-1.5">
                  <span>{l.description}</span>
                  <span className="shrink-0 tabular-nums">{formatRupees(l.amount_cents)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex justify-between text-base font-semibold">
              <span>New total</span>
              <span className="tabular-nums" data-testid="correction-total">
                {formatRupees(preview.built.summary.newTotalCents)}
              </span>
            </p>
            <p className="text-muted-foreground">Was {formatRupees(view.invoice.totalCents)} on {view.invoice.invoiceNo}, which will be cancelled.</p>
            {view.invoice.paidCents > 0 && (
              <p className="mt-1">
                {formatRupees(view.invoice.paidCents)} already paid is kept as credit and taken off the new bill
                {preview.keptCreditCents > 0 ? `; ${formatRupees(preview.keptCreditCents)} is left as credit for the next bills` : ""}.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{preview && !preview.ok && preview.message ? preview.message : "Change a reading or add a line to see the corrected bill."}</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">4. Reason and due date</h2>
        <div className="space-y-1.5">
          <Label htmlFor="correct-reason">Why is the bill corrected? (the customer sees it)</Label>
          <Textarea id="correct-reason" rows={3} className="text-base" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the reading was typed wrong; the meter shows 7,300" />
          {errors.reason && <p className="text-sm text-destructive">{errors.reason}</p>}
        </div>
        <FormField name="dueDate" label="Due date of the corrected bill" type="date" required min={view.today} value={dueDate} onChange={setDueDate} error={errors.dueDate} />
      </section>

      {message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={pending || !hydrated || !preview?.ok}>
        {pending ? "Saving…" : "Cancel the old bill and issue the corrected one"}
      </Button>
    </form>
  );
}
