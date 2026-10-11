"use client";

import { TriangleAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCount } from "@/lib/format";
import type { Preview, ReadingErrors, TypedText } from "@/lib/meter/readings";
import { formatRupees } from "@/lib/money";

/**
 * The reading boxes (INV-02, spec 6.4): B&W, plus colour for a colour machine, with
 * the phone's number keypad and labels that steer people away from the Total counter.
 */
export function ReadingFields({
  machineType,
  values,
  onChange,
  errors,
  previous,
  idPrefix = "reading",
}: {
  machineType: "MONO" | "COLOUR";
  values: TypedText;
  onChange: (values: TypedText) => void;
  errors: ReadingErrors;
  previous: { BW: number | null; COLOUR: number | null };
  idPrefix?: string;
}) {
  const fields: { key: "bw" | "colour"; label: string; hint: string; prev: number | null }[] = [
    {
      key: "bw",
      label: machineType === "COLOUR" ? "B&W counter" : "Meter reading",
      hint: machineType === "COLOUR" ? "The black and white counter, not the Total." : "The copy counter on the machine.",
      prev: previous.BW,
    },
  ];
  if (machineType === "COLOUR") fields.push({ key: "colour", label: "Colour counter", hint: "The colour counter, not the Total.", prev: previous.COLOUR });

  return (
    <div className="space-y-4">
      {machineType === "COLOUR" && <CounterSample />}
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const error = errors[f.key];
        return (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={id} className="text-base">
              {f.label}
            </Label>
            <Input
              id={id}
              name={f.key}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              enterKeyHint="next"
              value={values[f.key]}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value.replace(/[^\d,\s]/g, "") })}
              aria-invalid={Boolean(error)}
              aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
              className="h-14 text-2xl tabular-nums"
            />
            <p id={`${id}-hint`} className="text-sm text-muted-foreground">
              {f.hint}
              {f.prev !== null ? ` Last time: ${formatCount(f.prev)}.` : ""}
            </p>
            {error && (
              <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Spec 11.2 / 6.4: a sample counter screen, so the Total is not typed by mistake
 * (it adds B&W and colour together).
 */
function CounterSample() {
  const rows = [
    { label: "Total", value: "15,700", type: false },
    { label: "Black & White", value: "12,500", type: true },
    { label: "Full Colour", value: "3,200", type: true },
  ];
  return (
    <details className="rounded-xl border bg-background p-3" data-testid="counter-sample">
      <summary className="min-h-8 cursor-pointer font-medium">Which numbers do I type?</summary>
      <div className="mt-3 space-y-1 rounded-lg bg-slate-900 p-3 font-mono text-sm text-slate-100" aria-label="Example of a counter screen">
        {rows.map((r) => (
          <p key={r.label} className={r.type ? "flex justify-between" : "flex justify-between text-slate-400 line-through"}>
            <span>{r.label}</span>
            <span>{r.value}</span>
          </p>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Type the Black &amp; White and the Colour numbers. Do not type the Total: it adds both together.</p>
    </details>
  );
}

/** Usage per counter and the invoice the billing engine will create (warnings never block). */
export function ReadingPreview({ preview, audience }: { preview: Preview; audience: "customer" | "owner" }) {
  if (!preview.ok) {
    return preview.message ? (
      <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
        {preview.message}
      </p>
    ) : null;
  }
  const r = preview.result;
  return (
    <div className="space-y-3 rounded-xl border bg-background p-4" data-testid="reading-preview">
      <ul className="space-y-2">
        {preview.counters.map((c) => (
          <li key={c.counter}>
            <p className="font-medium">
              {c.counter === "BW" ? "B&W" : "Colour"}: {formatCount(c.usage)} copies
              {c.rolledOver && <span className="text-muted-foreground"> (counter went past its maximum)</span>}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatCount(c.previous)} → {formatCount(c.current)}
              {c.carried > 0 ? ` + ${formatCount(c.carried)} on the replaced meter` : ""} · {formatCount(c.included)} included
              {c.excess > 0 ? ` · ${formatCount(c.excess)} extra` : ""}
            </p>
            {c.warning && (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400" data-testid="reading-warning">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                {c.warning}
              </p>
            )}
          </li>
        ))}
      </ul>
      <dl className="space-y-1 border-t pt-3 text-sm">
        {r.lines.map((l, i) => (
          <div key={i} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{l.description}</dt>
            <dd className="tabular-nums">{formatRupees(l.amount_cents)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t pt-2 text-base font-semibold">
          <dt>{audience === "customer" ? "Your bill" : "Total"}</dt>
          <dd className="tabular-nums" data-testid="preview-total">
            {formatRupees(r.totalCents)}
          </dd>
        </div>
      </dl>
      {audience === "customer" && <p className="text-xs text-muted-foreground">Your rental company checks the photo and the reading before sending the bill.</p>}
    </div>
  );
}
