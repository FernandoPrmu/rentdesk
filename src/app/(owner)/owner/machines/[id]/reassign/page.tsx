import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { reassignMachineAction } from "@/app/(owner)/owner/machines/actions";
import { ReturnBlockers } from "@/components/agreements/agreement-display";
import { ReassignForm } from "@/components/agreements/agreement-forms";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { listCustomers } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { getAgreement, getLastKnownReadings, getReturnBlockers } from "@/lib/agreements/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getMachine } from "@/lib/machines/queries";

export const metadata: Metadata = { title: "Reassign machine" };

/** MAC-04: return + new assignment in one guided form, saved in one transaction. */
export default async function ReassignMachinePage({ params }: PageProps<"/owner/machines/[id]/reassign">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const machine = await getMachine(id);
  if (!machine) notFound();
  const title = `${machine.brand} ${machine.model}`;
  const agreement = machine.current ? await getAgreement(machine.current.id) : null;
  if (!agreement) {
    return (
      <div className="max-w-2xl space-y-4">
        <BackLink href={`/owner/machines/${id}`} label={title} />
        <PageHeader title="Reassign machine" />
        <p className="text-sm">This machine is not rented. Use “Assign to a customer” instead.</p>
      </div>
    );
  }

  const [blockers, lastReadings, customers] = await Promise.all([
    getReturnBlockers(agreement.id),
    getLastKnownReadings(agreement),
    listCustomers({ status: "ACTIVE" }),
  ]);

  return (
    <div className="max-w-2xl space-y-4">
      <BackLink href={`/owner/machines/${id}`} label={title} />
      <PageHeader title="Reassign machine" description={`${title} · ${machine.serial_no}`} />
      {blockers.length > 0 ? (
        <ReturnBlockers blockers={blockers} />
      ) : (
        <Card>
          <CardContent>
            <ReassignForm
              type={machine.type}
              today={todayInColombo()}
              currentCustomer={agreement.customer.name}
              customers={customers.filter((c) => c.id !== agreement.customer_id).map((c) => ({ id: c.id, name: c.name }))}
              lastReadings={lastReadings}
              action={reassignMachineAction.bind(null, id, agreement.id)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
