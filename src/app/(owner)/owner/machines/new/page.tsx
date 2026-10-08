import type { Metadata } from "next";

import { createMachineAction } from "@/app/(owner)/owner/machines/actions";
import { MachineForm } from "@/components/machines/machine-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "New machine" };

export default async function NewMachinePage() {
  await requireUser("OWNER");
  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/machines" label="Machines" />
      <PageHeader title="New machine" />
      <Card>
        <CardContent>
          <MachineForm mode="create" action={createMachineAction} />
        </CardContent>
      </Card>
    </div>
  );
}
