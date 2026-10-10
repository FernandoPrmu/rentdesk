import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { assignMachineAction } from "@/app/(owner)/owner/machines/actions";
import { AssignmentForm } from "@/components/agreements/agreement-forms";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { listCustomers } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { requireUser } from "@/lib/auth/current-user";
import { getMachine } from "@/lib/machines/queries";
import { MACHINE_STATUS_LABEL, MACHINE_TYPE_LABEL } from "@/lib/machines/schemas";
import { getLateFeeSources } from "@/lib/settings/billing";
import { describeOwnerDefault } from "@/lib/settings/billing-schema";

export const metadata: Metadata = { title: "Assign machine" };

/** MAC-02 / AGR-01. Opened from the machine, or from a customer (?customer=). */
export default async function AssignMachinePage({ params, searchParams }: PageProps<"/owner/machines/[id]/assign">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const machine = await getMachine(id);
  if (!machine) notFound();
  const { customer } = await searchParams;
  const [allCustomers, lateFee] = await Promise.all([listCustomers({ status: "ACTIVE" }), getLateFeeSources()]);
  const customers = allCustomers.map((c) => ({ id: c.id, name: c.name }));
  const fixedCustomer = typeof customer === "string" ? customers.find((c) => c.id === customer) : undefined;
  const title = `${machine.brand} ${machine.model}`;

  return (
    <div className="max-w-2xl">
      <BackLink href={fixedCustomer ? `/owner/customers/${fixedCustomer.id}` : `/owner/machines/${id}`} label={fixedCustomer ? fixedCustomer.name : title} />
      <PageHeader title="Assign machine" description={`${title} · ${machine.serial_no} · ${MACHINE_TYPE_LABEL[machine.type]}`} />
      <Card>
        <CardContent>
          {machine.status === "AVAILABLE" ? (
            <AssignmentForm
              type={machine.type}
              today={todayInColombo()}
              customers={customers}
              fixedCustomer={fixedCustomer}
              ownerLateFee={describeOwnerDefault(lateFee)}
              action={assignMachineAction.bind(null, id)}
            />
          ) : (
            <p className="text-sm">
              This machine is {MACHINE_STATUS_LABEL[machine.status].toLowerCase()}. Only an available machine can be assigned.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
