"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { BaselineInput, BaselineView } from "@/lib/agreements/baseline";
import { formatCount } from "@/lib/format";
import { parseReading } from "@/lib/meter/readings";

type Field = "bw" | "colour" | "oldBw" | "oldColour";

/**
 * 11.2 / 11.8 (decision 51): the meter was replaced or reset. Per counter that
 * changed: the new meter's starting reading and, if known, the old meter's last
 * reading, so the copies printed on it since the last reading are billed with the
 * next reading. Leave a counter empty when it did not change.
 */
export function BaselineForm({ view, action }: { view: BaselineView; action: (input: BaselineInput) => Promise<ActionResult & { fieldErrors?: Record<string, string> }> }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [values, setValues] = useState<Record<Field, string>>({ bw: "", colour: "", oldBw: "", oldColour: "" });
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (k: Field, v: string) => {
    setValues({ ...values, [k]: v.replace(/[^\d,\s]/g, "") });
    setErrors({});
    setMessage(null);
  };
  const carried = (old: string, previous: number) => {
    const p = parseReading(old, "old");
    return p.ok && p.value >= previous ? p.value - previous : null;
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        start(async () => {
          const result = await action({ agreementId: view.agreementId, reason, ...values });
          if (result.ok) {
            toast.success("New meter baseline recorded. The customer was told.");
            router.push(`/owner/agreements/${view.agreementId}`);
            return;
          }
          setErrors(result.fieldErrors ?? {});
          setMessage(result.error);
        });
      }}
    >
      {view.counters.map((c) => {
        const [newKey, oldKey]: [Field, Field] = c.counter === "BW" ? ["bw", "oldBw"] : ["colour", "oldColour"];
        const label = c.counter === "BW" ? (view.machineType === "COLOUR" ? "B&W counter" : "Meter") : "Colour counter";
        const extra = carried(values[oldKey], c.previous);
        return (
          <fieldset key={c.counter} className="space-y-3 rounded-xl border p-3">
            <legend className="px-1 text-base font-semibold">{label}</legend>
            <p className="text-sm text-muted-foreground">
              Last known reading: <strong>{formatCount(c.previous)}</strong>
              {c.carried > 0 ? ` (plus ${formatCount(c.carried)} copies already carried from a replaced meter)` : ""}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor={`baseline-${newKey}`}>New meter: starting reading</Label>
              <Input id={`baseline-${newKey}`} inputMode="numeric" className="h-12 text-lg" value={values[newKey]} onChange={(e) => set(newKey, e.target.value)} aria-invalid={Boolean(errors[newKey])} />
              {errors[newKey] && <p className="text-sm text-destructive">{errors[newKey]}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`baseline-${oldKey}`}>
                Old meter: last reading <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input id={`baseline-${oldKey}`} inputMode="numeric" className="h-12 text-lg" value={values[oldKey]} onChange={(e) => set(oldKey, e.target.value)} aria-invalid={Boolean(errors[oldKey])} />
              {errors[oldKey] ? (
                <p className="text-sm text-destructive">{errors[oldKey]}</p>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid={`carried-${c.counter}`}>
                  {extra !== null ? `${formatCount(extra)} copies printed on the old meter will be billed with the next reading.` : "Leave empty if not known: billing starts from the new meter only."}
                </p>
              )}
            </div>
          </fieldset>
        );
      })}
      <div className="space-y-1.5">
        <Label htmlFor="baseline-reason">What happened?</Label>
        <Textarea id="baseline-reason" rows={3} className="text-base" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the counter board was replaced by the technician" />
        {errors.reason && <p className="text-sm text-destructive">{errors.reason}</p>}
      </div>
      {message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={pending || !hydrated}>
        {pending ? "Saving…" : "Record new baseline"}
      </Button>
    </form>
  );
}
