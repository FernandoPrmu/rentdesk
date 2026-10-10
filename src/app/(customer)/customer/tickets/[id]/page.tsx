import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { CustomerTimeline } from "@/components/tickets/customer-timeline";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatCount, formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { getCustomerTicket } from "@/lib/tickets/queries";
import { isMeterStage } from "@/lib/tickets/states";
import { currentDue, nextStep, ticketFlags } from "@/lib/tickets/view";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Billing ticket" };

/**
 * The customer's billing ticket (CP-02): status, next step, deadline, the readings
 * sent and how they were reviewed (rejection reason, corrections as old → new), and
 * the history. Sending the reading is on the meter page. RLS: own tickets only.
 */
export default async function CustomerTicketPage({ params }: PageProps<"/customer/tickets/[id]">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const ticket = await getCustomerTicket(id);
  if (!ticket) notFound();
  const step = nextStep(ticket);
  const due = currentDue(ticket);
  const overdue = ticketFlags(ticket, new Date()).overdue;
  const meter = isMeterStage({ status: ticket.status, statusBeforeOverdue: ticket.status_before_overdue });
  const latest = ticket.submissions[0] ?? null;
  const rejected = meter && latest?.status === "REJECTED" ? latest : null;
  const inv = ticket.invoice;

  return (
    <div className="space-y-5">
      <div>
        <BackLink href="/customer" label="Home" />
        <h1 className="text-2xl font-bold tracking-tight">
          {ticket.machine.brand} {ticket.machine.model}
        </h1>
        <p className="text-sm text-muted-foreground">
          {formatDate(ticket.period_start)} to {formatDate(ticket.period_end)}
        </p>
        <p className="mt-1 font-medium" data-testid="customer-ticket-status">
          {ticket.status === "OVERDUE" ? "Overdue" : (TICKET_STATUS_LABEL[ticket.status] ?? ticket.status)}
        </p>
      </div>

      <Card className={cn(overdue && "border-destructive/50")}>
        <CardContent className="space-y-3">
          <p className="text-lg font-semibold">{step.who === "CUSTOMER" ? step.label : "Nothing to do now: your rental company is on it."}</p>
          {step.who === "CUSTOMER" && due?.kind === "day" && (
            <p className={cn("text-sm font-medium", overdue && "text-destructive")}>
              {overdue ? `Late: it was due by ${formatDate(due.date)}` : `By ${formatDate(due.date)}`}
            </p>
          )}
          {rejected && (
            <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm" data-testid="rejection-reason">
              <strong>Your reading was not accepted:</strong> {rejected.reject_reason}
            </p>
          )}
          {meter && !ticket.paused_at && (
            <Link href={`/customer/tickets/${ticket.id}/meter`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
              {rejected ? "Send the reading again" : "Enter meter reading"}
            </Link>
          )}
          {inv?.invoice_no && (
            <p className="text-sm" data-testid="customer-bill">
              Bill {inv.invoice_no}: {formatRupees(inv.total_cents - inv.amount_paid_cents)} to pay
              {inv.due_date ? ` by ${formatDate(inv.due_date)}` : ""}
            </p>
          )}
          {step.who === "CUSTOMER" && !meter && inv?.id && (
            <Link href={`/customer/pay?invoice=${inv.id}`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
              Pay and send slip
            </Link>
          )}
          {inv?.invoice_no && inv.id && (
            <Link href={`/customer/bills/${inv.id}`} className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full text-base")}>
              View the bill and PDF
            </Link>
          )}
        </CardContent>
      </Card>

      {latest && latest.status !== "REJECTED" && (
        <Card>
          <CardHeader>
            <CardTitle>{latest.source === "OWNER_MANUAL" ? "Reading entered by your rental company" : "Your reading"}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {[...latest.readings]
                .sort((a, b) => a.counter_type.localeCompare(b.counter_type))
                .map((r) => (
                  <li key={r.counter_type}>
                    {r.counter_type === "BW" ? "B&W" : "Colour"}:{" "}
                    {r.corrected_from_value !== null ? (
                      <>
                        <span className="text-muted-foreground line-through">{formatCount(r.corrected_from_value)}</span> {formatCount(r.current_value)}
                        <span className="block text-sm text-muted-foreground">Corrected by your rental company: {r.correction_note}</span>
                      </>
                    ) : (
                      formatCount(r.current_value)
                    )}
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerTimeline events={ticket.events} customerId={user.id} />
        </CardContent>
      </Card>
    </div>
  );
}
