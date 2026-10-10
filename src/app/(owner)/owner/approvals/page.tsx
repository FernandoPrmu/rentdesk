import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { TicketList } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { listOwnerTickets } from "@/lib/tickets/queries";

export const metadata: Metadata = { title: "Approvals" };

/** Readings and estimated invoices waiting for the owner's review (INV-07), oldest deadline first. */
export default async function ApprovalsPage() {
  await requireUser("OWNER");
  const tickets = await listOwnerTickets("PENDING_OWNER_REVIEW");
  return (
    <>
      <PageHeader title="Approvals" description="Meter readings and estimated invoices waiting for your review." />
      <TicketList tickets={tickets} now={new Date()} empty="Nothing waiting for your review." hrefSuffix="/review" />
    </>
  );
}
