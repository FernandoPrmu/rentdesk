import type { Metadata } from "next";

import { DeliveryLog } from "@/components/notifications/delivery-log";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { deliveryLog, logFilterSchema } from "@/lib/notifications/queries";

export const metadata: Metadata = { title: "Delivery log" };

/** The owner's delivery log (NOT-05): their tenant's notifications and emails (RLS). */
export default async function OwnerDeliveryLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser("OWNER");
  const filter = logFilterSchema.parse({ ...(await searchParams), owner: undefined });
  const { rows, more } = await deliveryLog(filter);
  return (
    <div className="space-y-4">
      <BackLink href="/owner/settings/notifications" label="Emails" />
      <PageHeader title="Delivery log" description="Every notification and email to you and your customers: sent, failed, skipped or read." />
      <DeliveryLog rows={rows} more={more} filter={filter} path="/owner/settings/notifications/log" />
    </div>
  );
}
