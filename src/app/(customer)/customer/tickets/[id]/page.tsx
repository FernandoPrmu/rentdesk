import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { getCustomerTicket } from "@/lib/tickets/queries";
import { currentDue, nextStep } from "@/lib/tickets/view";

export const metadata: Metadata = { title: "Billing ticket" };

/**
 * The customer's billing ticket (CP-02). Placeholder until the meter reading
 * (CP-03, live camera) and payment slip (CP-04) screens arrive: it shows the
 * stage, the next step and the deadline. RLS: own tickets only.
 */
export default async function CustomerTicketPage({ params }: PageProps<"/customer/tickets/[id]">) {
  await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const ticket = await getCustomerTicket(id);
  if (!ticket) notFound();
  const step = nextStep(ticket);
  const due = currentDue(ticket);

  return (
    <div className="space-y-5">
      <div>
        <BackLink href="/customer" label="Home" />
        <h1 className="text-2xl font-bold tracking-tight">
          {ticket.machine.brand} {ticket.machine.model}
        </h1>
        <p className="text-sm text-muted-foreground">
          {formatDate(ticket.period_start)} to {formatDate(ticket.period_end)} · {TICKET_STATUS_LABEL[ticket.status] ?? ticket.status}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-2">
          <p className="text-lg font-semibold">{step.who === "CUSTOMER" ? step.label : "Nothing to do now: your rental company is on it."}</p>
          {step.who === "CUSTOMER" && due?.kind === "day" && <p className="text-sm">By {formatDate(due.date)}</p>}
          {ticket.invoice && ticket.invoice.invoice_no && (
            <p className="text-sm text-muted-foreground">
              Bill {ticket.invoice.invoice_no}: {formatRupees(ticket.invoice.total_cents - ticket.invoice.amount_paid_cents)} to pay
            </p>
          )}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        Sending the meter reading with the camera, and the payment slip, will be available here soon.
      </p>
    </div>
  );
}
