import type { Metadata } from "next";

import { AgreementCards } from "@/components/agreements/agreement-cards";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { listCustomerAgreements } from "@/lib/agreements/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getDepositsHeld } from "@/lib/deposits/queries";

export const metadata: Metadata = { title: "Machines" };

/**
 * Customer portal: the machines this customer rents now, read-only, with the
 * deposit held for each (DEP-01). A returned machine whose deposit is still held
 * stays listed until it is settled. RLS returns only the customer's own rows.
 */
export default async function CustomerMachinesPage() {
  const user = await requireUser("CUSTOMER");
  const all = await listCustomerAgreements(user.id);
  const deposits = await getDepositsHeld(all.map((a) => a.id));
  const agreements = all.filter((a) => a.status !== "TERMINATED");
  const returnedWithDeposit = all.filter((a) => a.status === "TERMINATED" && (deposits.get(a.id) ?? 0) > 0);
  const today = todayInColombo();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Your machines</h1>
      <AgreementCards
        agreements={agreements}
        today={today}
        deposits={deposits}
        empty="You have no machines on rent at the moment. Your machine owner adds them here."
      />
      {agreements.length > 0 && (
        <p className="text-sm text-muted-foreground">
          On the meter reading day you get a request to photograph the meter and type the reading. Questions about your terms? Contact your
          machine owner.
        </p>
      )}
      {returnedWithDeposit.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Returned, deposit still held</h2>
          <AgreementCards agreements={returnedWithDeposit} today={today} deposits={deposits} empty="" />
          <p className="text-sm text-muted-foreground">Your machine owner settles the deposit: it pays open bills and the rest is refunded.</p>
        </section>
      )}
    </div>
  );
}
