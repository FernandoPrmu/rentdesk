import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { ReturnBlocker, TermsVersion } from "@/lib/agreements/queries";
import { describeVersions } from "@/lib/agreements/terms";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";

/** Label / value pairs: stacked on a phone, two columns from sm up. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TermsValues {
  monthly_commitment_cents: number;
  bw_included: number;
  bw_rate_cents: number;
  colour_included: number | null;
  colour_rate_cents: number | null;
  due_days: number;
  late_fee_mode: string;
  late_fee_cents: number | null;
}

/** LATE-01 in words; `ownerDefault` explains "use my default". */
export function lateFeeText(t: { late_fee_mode: string; late_fee_cents: number | null }, ownerDefault?: string): string {
  if (t.late_fee_mode === "NONE") return "No late fee";
  if (t.late_fee_mode === "CUSTOM" && t.late_fee_cents !== null) return `${formatRupees(t.late_fee_cents)} (this agreement)`;
  return ownerDefault ? `Owner default: ${ownerDefault}` : "Owner default";
}

export function termsFacts(t: TermsValues, ownerDefault?: string): [string, ReactNode][] {
  const items: [string, ReactNode][] = [
    ["Monthly commitment", formatRupees(t.monthly_commitment_cents)],
    ["Included B&W copies", formatCount(t.bw_included)],
    ["B&W excess rate", `${formatRupees(t.bw_rate_cents)} per copy`],
  ];
  if (t.colour_included !== null && t.colour_rate_cents !== null) {
    items.push(["Included colour copies", formatCount(t.colour_included)]);
    items.push(["Colour excess rate", `${formatRupees(t.colour_rate_cents)} per copy`]);
  }
  items.push(["Days to pay", `${t.due_days} days`]);
  items.push(["Late fee", lateFeeText(t, ownerDefault)]);
  return items;
}

function versionTerms(v: TermsVersion) {
  const parts = [
    `${formatRupees(v.monthly_commitment_cents)} / cycle`,
    `${formatCount(v.bw_included)} B&W incl., ${formatRupees(v.bw_rate_cents)} extra`,
  ];
  if (v.colour_included !== null && v.colour_rate_cents !== null) {
    parts.push(`${formatCount(v.colour_included)} colour incl., ${formatRupees(v.colour_rate_cents)} extra`);
  }
  parts.push(`pay in ${v.due_days} days`);
  parts.push(`late fee: ${lateFeeText(v).toLowerCase()}`);
  return parts.join(" · ");
}

/** AGR-02: every version, who changed it, when, and from which cycle it applies. */
export function TermsHistory({
  history,
  nextCycleNo,
  cycleDateOf,
}: {
  history: TermsVersion[];
  nextCycleNo: number;
  cycleDateOf: (cycleNo: number) => string;
}) {
  const rows = describeVersions(history, nextCycleNo);
  return (
    <ol className="space-y-3" aria-label="Terms history">
      {rows.map((v) => (
        <li key={v.id} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Version {v.version}</span>
            <span className="text-muted-foreground">
              from cycle {v.effective_from_cycle_no} ({formatDate(cycleDateOf(v.effective_from_cycle_no))})
            </span>
            {v.inForce && <Badge variant="secondary">Current</Badge>}
            {v.pending && <Badge>From next cycle</Badge>}
            {v.superseded && <Badge variant="outline">Replaced before use</Badge>}
          </div>
          <p className="mt-1">{versionTerms(v)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {v.changer?.full_name ?? v.changer?.username ?? "System"}, {formatDateTime(v.changed_at)}
            {v.note ? ` — ${v.note}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** RET-01: only a meter reading waiting for review blocks a return. */
export function ReturnBlockers({ blockers }: { blockers: ReturnBlocker[] }) {
  return (
    <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle className="size-5" aria-hidden />
        This machine cannot be returned yet
      </p>
      <p>
        A meter reading is waiting for your review. Confirm or correct it first, so the final bill uses confirmed numbers. Unpaid invoices do not
        stop a return.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {blockers.map((b) => (
          <li key={b.id}>
            {b.label}: {TICKET_STATUS_LABEL[b.status] ?? b.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
