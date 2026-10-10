import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import type { OwnerTicketRow, TicketFilter } from "@/lib/tickets/queries";
import type { TicketStatus } from "@/lib/tickets/states";
import { currentDue, type Due, nextStep, ticketFlags, type TicketView } from "@/lib/tickets/view";

/** Status, with where an overdue ticket came from ("Overdue · meter reading"). */
export function TicketStatusBadge({ status, before }: { status: TicketStatus; before: TicketStatus | null }) {
  const variant = status === "OVERDUE" ? "destructive" : status === "CLOSED" || status === "CANCELLED" ? "outline" : "secondary";
  const origin = status === "OVERDUE" && before ? (before === "METER_REQUESTED" ? " · meter reading" : " · payment") : "";
  return <Badge variant={variant}>{`${TICKET_STATUS_LABEL[status] ?? status}${origin}`}</Badge>;
}

/** Overdue / escalated / paused badges (owner list and detail). */
export function TicketFlagBadges({ ticket, now }: { ticket: TicketView; now: Date }) {
  const f = ticketFlags(ticket, now);
  return (
    <>
      {f.overdue && ticket.status !== "OVERDUE" && <Badge variant="destructive">Overdue</Badge>}
      {f.escalated && <Badge variant="destructive">{ticket.escalation_level >= 2 ? "Escalated to admin" : "Escalated"}</Badge>}
      {f.paused && <Badge variant="outline">Paused</Badge>}
    </>
  );
}

export function dueText(due: Due | null): string {
  if (!due) return "—";
  return due.kind === "day" ? `by ${formatDate(due.date)}` : `by ${formatDateTime(due.at)}`;
}

const WHO_LABEL = { CUSTOMER: "Customer", OWNER: "You" } as const;

const FILTER_LABEL: Record<TicketFilter, string> = {
  OPEN: "All open",
  ALL: "All tickets",
  ESCALATED: "Escalated",
  ...(TICKET_STATUS_LABEL as Record<TicketStatus, string>),
};

/** Status filter: a GET form, keyed by the URL filter so it remounts with it. */
export function TicketFilters({ filter, options }: { filter: TicketFilter; options: readonly TicketFilter[] }) {
  return (
    <form key={filter} method="get" role="search" className="mb-4 flex gap-2">
      <div className="flex-1 sm:max-w-64">
        <ChoiceSelect name="status" ariaLabel="Status" defaultValue={filter} options={options.map((o) => ({ value: o, label: FILTER_LABEL[o] }))} />
      </div>
      <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
        Show
      </Button>
    </form>
  );
}

function amountText(t: OwnerTicketRow) {
  if (!t.invoice) return null;
  const left = t.invoice.total_cents - t.invoice.amount_paid_cents;
  return left > 0 && left !== t.invoice.total_cents ? `${formatRupees(left)} of ${formatRupees(t.invoice.total_cents)} left` : formatRupees(t.invoice.total_cents);
}

/** TKT-06: cards on a phone, a table from md up. */
export function TicketList({ tickets, now, empty }: { tickets: OwnerTicketRow[]; now: Date; empty: string }) {
  if (tickets.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <>
      <ul className="divide-y overflow-hidden rounded-xl border bg-background md:hidden" aria-label="Tickets">
        {tickets.map((t) => {
          const step = nextStep(t);
          return (
            <li key={t.id} data-testid="ticket-card">
              <Link href={`/owner/tickets/${t.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{t.customer.name}</span>
                    <TicketStatusBadge status={t.status} before={t.status_before_overdue} />
                    <TicketFlagBadges ticket={t} now={now} />
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {t.machine.brand} {t.machine.model} · cycle {t.cycle_no} · {formatDate(t.cycle_date)}
                  </p>
                  <p className="text-sm">
                    {step.who ? `${WHO_LABEL[step.who]}: ` : ""}
                    {step.label}
                    {currentDue(t) && <span className="text-muted-foreground"> {dueText(currentDue(t))}</span>}
                  </p>
                </div>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-hidden rounded-xl border bg-background md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Machine</th>
              <th className="px-4 py-3 font-medium">Cycle</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Next step</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tickets.map((t) => {
              const step = nextStep(t);
              return (
                <tr key={t.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/owner/tickets/${t.id}`} className="font-medium hover:underline">
                      {t.customer.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {t.machine.brand} {t.machine.model}
                    <span className="block font-mono text-xs text-muted-foreground">{t.machine.serial_no}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {t.cycle_no} · {formatDate(t.cycle_date)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <TicketStatusBadge status={t.status} before={t.status_before_overdue} />
                      <TicketFlagBadges ticket={t} now={now} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {step.who ? `${WHO_LABEL[step.who]}: ` : ""}
                    {step.label}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{dueText(currentDue(t))}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{amountText(t) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
