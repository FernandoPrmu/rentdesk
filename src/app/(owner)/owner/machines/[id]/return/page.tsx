import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { returnMachineAction } from "@/app/(owner)/owner/agreements/actions";
import { ReturnBlockers } from "@/components/agreements/agreement-display";
import { ReturnForm } from "@/components/agreements/agreement-forms";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { getAgreement, getLastKnownReadings, getReturnBlockers } from "@/lib/agreements/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getMachine } from "@/lib/machines/queries";

export const metadata: Metadata = { title: "Return machine" };

/** MAC-04: closing readings + reason; blocked while billing is open. */
export default async function ReturnMachinePage({ params }: PageProps<"/owner/machines/[id]/return">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const machine = await getMachine(id);
  if (!machine) notFound();
  const title = `${machine.brand} ${machine.model}`;
  const agreement = machine.current ? await getAgreement(machine.current.id) : null;

  return (
    <div className="max-w-2xl space-y-4">
      <BackLink href={`/owner/machines/${id}`} label={title} />
      <PageHeader
        title="Return machine"
        description={agreement ? `${title} · ${machine.serial_no} · from ${agreement.customer.name}` : `${title} · ${machine.serial_no}`}
      />
      {agreement ? <ReturnBody agreement={agreement} /> : <p className="text-sm">This machine is not rented.</p>}
    </div>
  );
}

async function ReturnBody({ agreement }: { agreement: NonNullable<Awaited<ReturnType<typeof getAgreement>>> }) {
  const [blockers, lastReadings] = await Promise.all([getReturnBlockers(agreement.id), getLastKnownReadings(agreement)]);
  if (blockers.length > 0) return <ReturnBlockers blockers={blockers} />;
  return (
    <Card>
      <CardContent>
        <ReturnForm type={agreement.machine.type} lastReadings={lastReadings} action={returnMachineAction.bind(null, agreement.id)} />
      </CardContent>
    </Card>
  );
}
