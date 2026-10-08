import type { Metadata } from "next";

import { AgreementCards } from "@/components/agreements/agreement-cards";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { listCustomerAgreements } from "@/lib/agreements/queries";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Machines" };

/**
 * Customer portal: the machines this customer rents now, read-only. RLS returns
 * only the customer's own agreements, never another customer's.
 */
export default async function CustomerMachinesPage() {
  const user = await requireUser("CUSTOMER");
  const agreements = (await listCustomerAgreements(user.id)).filter((a) => a.status !== "TERMINATED");

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Your machines</h1>
      <AgreementCards
        agreements={agreements}
        today={todayInColombo()}
        empty="You have no machines on rent at the moment. Your machine owner adds them here."
      />
      {agreements.length > 0 && (
        <p className="text-sm text-muted-foreground">
          On the meter reading day you get a request to photograph the meter and type the reading. Questions about your terms? Contact your
          machine owner.
        </p>
      )}
    </div>
  );
}
