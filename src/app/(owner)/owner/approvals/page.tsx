import type { Metadata } from "next";

import { PaymentList } from "@/components/payments/payment-views";
import { PageHeader } from "@/components/portal/portal-shell";
import { TicketList } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { listOwnerTickets } from "@/lib/tickets/queries";

export const metadata: Metadata = { title: "Approvals" };

/** Readings and estimated invoices (INV-07) and payment slips (PAY-05) waiting for the owner, oldest first. */
export default async function ApprovalsPage() {
  await requireUser("OWNER");
  const [tickets, payments] = await Promise.all([listOwnerTickets("PENDING_OWNER_REVIEW"), listPayments(await createClient(), { status: "TO_VERIFY" })]);
  return (
    <>
      <PageHeader title="Approvals" description="Meter readings, estimated invoices and payment slips waiting for you." />
      <section className="space-y-2" aria-labelledby="approvals-readings">
        <h2 id="approvals-readings" className="text-lg font-semibold">Readings to review</h2>
        <TicketList tickets={tickets} now={new Date()} empty="Nothing waiting for your review." hrefSuffix="/review" />
      </section>
      <section className="mt-6 space-y-2" aria-labelledby="approvals-payments">
        <h2 id="approvals-payments" className="text-lg font-semibold">Payments to verify</h2>
        <PaymentList payments={payments} hrefBase="/owner/payments" audience="OWNER" empty="No payment slips waiting for you." />
      </section>
    </>
  );
}
