import type { Metadata } from "next";

import Link from "next/link";

import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { TicketFilters, TicketList } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { countApprovals, listOwnerTickets, TICKET_FILTERS, ticketFilterSchema } from "@/lib/tickets/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Tickets" };

/**
 * Billing cycle tickets (TKT-06): status filter, overdue and escalated badges,
 * cards on a phone. Read-only for now; review and payment actions come next.
 */
export default async function OwnerTicketsPage({ searchParams }: PageProps<"/owner/tickets">) {
  await requireUser("OWNER");
  const { status } = ticketFilterSchema.parse(await searchParams);
  const [tickets, approvals] = await Promise.all([listOwnerTickets(status), countApprovals()]);
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Billing tickets"
        description="One ticket per machine per month: meter reading, invoice, payment."
        action={
          <Link href="/owner/approvals" className={cn(buttonVariants({ variant: approvals > 0 ? "default" : "outline" }), "h-12 px-5 text-base")}>
            Approvals ({approvals})
          </Link>
        }
      />
      <TicketFilters filter={status} options={TICKET_FILTERS} />
      <TicketList
        tickets={tickets}
        now={now}
        empty={status === "OPEN" ? "No open tickets. New ones open on each machine's billing day." : "No tickets match this filter."}
      />
    </>
  );
}
