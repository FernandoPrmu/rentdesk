import Link from "next/link";

import { MachineTypeBadge } from "@/components/machines/machine-badges";
import { Badge } from "@/components/ui/badge";
import type { CustomerAgreement } from "@/lib/agreements/queries";
import { isEndingSoon } from "@/lib/agreements/cycle-calendar";
import { formatCount, formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";

/** One line of terms: commitment, included copies and rates. */
export function termsLine(a: CustomerAgreement) {
  const parts = [
    `${formatRupees(a.monthly_commitment_cents)} every ${a.cycle_length_days} days`,
    `${formatCount(a.bw_included)} B&W copies included, then ${formatRupees(a.bw_rate_cents)} each`,
  ];
  if (a.colour_included !== null && a.colour_rate_cents !== null) {
    parts.push(`${formatCount(a.colour_included)} colour copies included, then ${formatRupees(a.colour_rate_cents)} each`);
  }
  return parts;
}

/**
 * A customer's machines and agreements. The owner portal links each one to the
 * agreement; the customer portal shows the same facts read-only.
 */
export function AgreementCards({
  agreements,
  today,
  linkBase,
  empty,
}: {
  agreements: CustomerAgreement[];
  today: string;
  linkBase?: string;
  empty: string;
}) {
  if (agreements.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3">
      {agreements.map((a) => {
        const live = a.status !== "TERMINATED";
        const title = `${a.machine.brand} ${a.machine.model}`;
        return (
          <li key={a.id} className="rounded-xl border bg-background p-4" data-testid="agreement-card">
            <div className="flex flex-wrap items-center gap-2">
              {linkBase ? (
                <Link href={`${linkBase}/${a.id}`} className="font-semibold text-primary hover:underline">
                  {title}
                </Link>
              ) : (
                <span className="font-semibold">{title}</span>
              )}
              <MachineTypeBadge type={a.machine.type} />
              {!live && <Badge variant="outline">Returned</Badge>}
              {live && isEndingSoon(a.end_date, today) && <Badge variant="destructive">Ending soon</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Serial <span className="font-mono">{a.machine.serial_no}</span>
              {a.installation_location ? ` · ${a.installation_location}` : ""}
            </p>
            <ul className="mt-2 space-y-0.5 text-sm">
              {termsLine(a).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              {live ? (
                <>
                  Next meter reading: <strong>{formatDate(a.next_cycle_date)}</strong>
                  {a.end_date ? ` · ends ${formatDate(a.end_date)}` : ""}
                </>
              ) : (
                <>
                  {formatDate(a.start_date)} – {a.end_date ? formatDate(a.end_date) : "—"}
                </>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
