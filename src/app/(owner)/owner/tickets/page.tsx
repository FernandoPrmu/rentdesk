import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { TicketFilters, TicketList } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { listOwnerTickets, TICKET_FILTERS, ticketFilterSchema } from "@/lib/tickets/queries";

export const metadata: Metadata = { title: "Tickets" };

/**
 * Billing cycle tickets (TKT-06): status filter, overdue and escalated badges,
 * cards on a phone. Read-only for now; review and payment actions come next.
 */
export default async function OwnerTicketsPage({ searchParams }: PageProps<"/owner/tickets">) {
  await requireUser("OWNER");
  const { status } = ticketFilterSchema.parse(await searchParams);
  const tickets = await listOwnerTickets(status);
  const now = new Date();

  return (
    <>
      <PageHeader title="Billing tickets" description="One ticket per machine per month: meter reading, invoice, payment." />
      <TicketFilters filter={status} options={TICKET_FILTERS} />
      <TicketList
        tickets={tickets}
        now={now}
        empty={status === "OPEN" ? "No open tickets. New ones open on each machine's billing day." : "No tickets match this filter."}
      />
    </>
  );
}
