import type { Metadata } from "next";

import { DeliveryLog } from "@/components/notifications/delivery-log";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { deliveryLog, logFilterSchema } from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Delivery log" };

/** The full delivery log (NOT-05, ADM-05): every owner, and the admins' own alerts. */
export default async function AdminDeliveryLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser("ADMIN");
  const filter = logFilterSchema.parse(await searchParams);
  const supabase = await createClient();
  const [{ rows, more }, { data: owners }] = await Promise.all([deliveryLog(filter), supabase.from("owners").select("id, business_name").order("business_name")]);
  return (
    <div className="space-y-4">
      <BackLink href="/admin/emails" label="Emails" />
      <PageHeader title="Delivery log" description="Every notification and email, for every owner." />
      <DeliveryLog rows={rows} more={more} filter={filter} path="/admin/emails/log" owners={(owners ?? []).map((o) => ({ id: o.id, name: o.business_name }))} />
    </div>
  );
}
