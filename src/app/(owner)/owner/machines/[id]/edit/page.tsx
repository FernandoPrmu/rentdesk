import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { updateMachineAction } from "@/app/(owner)/owner/machines/actions";
import { MachineForm } from "@/components/machines/machine-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { getMachine } from "@/lib/machines/queries";

export const metadata: Metadata = { title: "Edit machine" };

export default async function EditMachinePage({ params }: PageProps<"/owner/machines/[id]/edit">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const machine = await getMachine(id);
  if (!machine) notFound();

  return (
    <div className="max-w-2xl">
      <BackLink href={`/owner/machines/${id}`} label={`${machine.brand} ${machine.model}`} />
      <PageHeader title="Edit machine" description={machine.serial_no} />
      <Card>
        <CardContent>
          <MachineForm
            mode="edit"
            action={updateMachineAction.bind(null, id)}
            backHref={`/owner/machines/${id}`}
            defaults={{
              brand: machine.brand,
              model: machine.model,
              serial_no: machine.serial_no,
              type: machine.type,
              purchase_date: machine.purchase_date,
              bw_counter_max: machine.bw_counter_max,
              colour_counter_max: machine.colour_counter_max,
              notes: machine.notes,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
