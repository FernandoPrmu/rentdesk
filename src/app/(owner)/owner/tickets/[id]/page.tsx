import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { dueText, TicketFlagBadges, TicketStatusBadge } from "@/components/tickets/ticket-display";
import { TicketTimeline } from "@/components/tickets/ticket-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { INVOICE_STATUS_LABEL } from "@/lib/status-labels";
import { getTicket } from "@/lib/tickets/queries";
import { currentDue, nextStep } from "@/lib/tickets/view";

export const metadata: Metadata = { title: "Ticket" };

/** TKT-06: the current stage, who must act, the due date and the full history. */
export default async function OwnerTicketPage({ params }: PageProps<"/owner/tickets/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const ticket = await getTicket(id);
  if (!ticket) notFound();
  const now = new Date();
  const step = nextStep(ticket);
  const inv = ticket.invoice;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/owner/tickets" label="Tickets" />
        <PageHeader
          title={`Cycle ${ticket.cycle_no} · ${formatDate(ticket.cycle_date)}`}
          description={`${ticket.customer.name} · ${ticket.machine.brand} ${ticket.machine.model} (${ticket.machine.serial_no})`}
        />
        <div className="-mt-3 flex flex-wrap gap-2">
          <TicketStatusBadge status={ticket.status} before={ticket.status_before_overdue} />
          <TicketFlagBadges ticket={ticket} now={now} />
          {ticket.is_late && <span className="text-sm text-muted-foreground">Reading came late</span>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Now</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">Who acts</dt>
              <dd className="font-medium" data-testid="ticket-who">
                {step.who === "OWNER" ? "You" : step.who === "CUSTOMER" ? ticket.customer.name : "Nobody"}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Next step</dt>
              <dd className="font-medium">{step.label}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Due</dt>
              <dd className="font-medium">{dueText(currentDue(ticket))}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            Period {formatDate(ticket.period_start)} to {formatDate(ticket.period_end)} ({ticket.cycle_length_days} days).{" "}
            <Link href={`/owner/agreements/${ticket.agreement_id}`} className="underline underline-offset-4">
              Agreement
            </Link>
          </p>
        </CardContent>
      </Card>

      {inv && (
        <Card>
          <CardHeader>
            <CardTitle>{inv.type === "ESTIMATED" ? "Estimated invoice" : "Invoice"}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="font-medium">{inv.invoice_no ?? "Draft (not numbered yet)"}</p>
              <p className="text-sm text-muted-foreground">
                {INVOICE_STATUS_LABEL[inv.status] ?? inv.status}
                {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}
                {inv.amount_paid_cents > 0 ? ` · ${formatRupees(inv.amount_paid_cents)} paid` : ""}
              </p>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{formatRupees(inv.total_cents)}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <TicketTimeline events={ticket.events} />
        </CardContent>
      </Card>
    </div>
  );
}
