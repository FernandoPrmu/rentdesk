import type { Metadata } from "next";

import { must } from "@/lib/actions/errors";
import { PageHeader } from "@/components/portal/portal-shell";
import { RequestList } from "@/components/service/request-list";
import { ServiceFilters } from "@/components/service/service-filters";
import { requireUser } from "@/lib/auth/current-user";
import { listOwnerRequests, serviceFilterSchema } from "@/lib/service/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Service requests" };

/**
 * SRV-03..05: the owner's service requests. Open ones first, URGENT and HIGH at the
 * top (decision 62), with "Not acknowledged in time" and escalation badges; filters
 * for status, urgency, type, machine and customer; cards on a phone.
 */
export default async function OwnerServicePage({ searchParams }: PageProps<"/owner/service">) {
  const user = await requireUser("OWNER");
  const filter = serviceFilterSchema.parse(await searchParams);
  const supabase = await createClient();
  const [rows, machines, customers] = await Promise.all([
    listOwnerRequests(user.id, filter),
    supabase.from("machines").select("id, brand, model, serial_no").order("serial_no"),
    supabase.from("customers").select("id, name").order("name"),
  ]);
  const filtered = filter.status !== "OPEN" || filter.urgency || filter.type || filter.machine || filter.customer;
  return (
    <>
      <PageHeader title="Service requests" description="Breakdowns, toner, parts and maintenance from your customers." />
      <ServiceFilters
        filter={filter}
        machines={(must(machines, "machines") ?? []).map((m) => ({ id: m.id, label: `${m.serial_no} · ${m.brand} ${m.model}` }))}
        customers={must(customers, "customers") ?? []}
      />
      <RequestList rows={rows} hrefBase="/owner/service" showCustomer empty={filtered ? "No requests match these filters." : "No open service requests."} />
    </>
  );
}
