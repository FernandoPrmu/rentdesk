import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { submitMeterReadingAction } from "@/app/(customer)/customer/tickets/actions";
import { MeterEntry } from "@/components/meter/meter-entry";
import { BackLink } from "@/components/portal/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { getMeterEntry } from "@/lib/meter/service";

export const metadata: Metadata = { title: "Enter meter reading" };

/** CP-03: live photo + reading(s) + preview, for the customer's own ticket. */
export default async function MeterEntryPage({ params }: PageProps<"/customer/tickets/[id]/meter">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const view = await getMeterEntry(user, id);
  if (!view) notFound();

  return (
    <div className="space-y-3">
      <BackLink href={`/customer/tickets/${id}`} label="Ticket" />
      {view.blocked ? (
        <Card>
          <CardContent className="space-y-1">
            <p className="text-lg font-semibold">{view.machine}</p>
            <p data-testid="meter-blocked">{view.blocked}</p>
          </CardContent>
        </Card>
      ) : (
        <MeterEntry view={view} action={submitMeterReadingAction} />
      )}
    </div>
  );
}
