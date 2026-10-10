import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { manualEntryAction } from "@/app/(owner)/owner/tickets/actions";
import { ManualEntryForm } from "@/components/meter/manual-entry-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { getManualEntry } from "@/lib/meter/service";

export const metadata: Metadata = { title: "Enter reading" };

/** INV-12: the owner enters the reading when the customer cannot (no photo; reason required; audited). */
export default async function ManualEntryPage({ params }: PageProps<"/owner/tickets/[id]/enter">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const view = await getManualEntry(owner, id);
  if (!view) notFound();
  const t = view.ticket;

  return (
    <div className="max-w-xl space-y-5">
      <div>
        <BackLink href={`/owner/tickets/${t.id}`} label="Ticket" />
        <PageHeader title="Enter the reading" description={`${t.customer_name} · ${t.machine_name} (${t.serial_no}) · cycle ${t.cycle_no}`} />
      </div>
      {view.allowed && view.context && view.previous ? (
        <>
          <p className="text-sm text-muted-foreground">
            Use this when the customer cannot send a photo (no camera, too many rejected readings, or they read it out to you). The customer is told.
          </p>
          <ManualEntryForm ticketId={t.id} machineType={t.machine_type} context={view.context} previous={view.previous} action={manualEntryAction} />
        </>
      ) : (
        <Card>
          <CardContent>This ticket is not waiting for a meter reading.</CardContent>
        </Card>
      )}
    </div>
  );
}
