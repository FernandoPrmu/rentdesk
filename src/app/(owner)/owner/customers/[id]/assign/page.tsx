import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MachineTypeBadge } from "@/components/machines/machine-badges";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { getCustomer } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { listAvailableMachines } from "@/lib/machines/queries";

export const metadata: Metadata = { title: "Assign a machine" };

/** Step 1 of assigning from a customer (MAC-02): pick one of the owner's available machines. */
export default async function PickMachinePage({ params }: PageProps<"/owner/customers/[id]/assign">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const customer = await getCustomer(id);
  if (!customer) notFound();
  const machines = await listAvailableMachines();

  return (
    <div className="max-w-2xl">
      <BackLink href={`/owner/customers/${id}`} label={customer.name} />
      <PageHeader title="Assign a machine" description={`Choose an available machine for ${customer.name}.`} />
      {customer.profile.status !== "ACTIVE" ? (
        <p className="text-sm">This customer account is not active. Reactivate it before assigning a machine.</p>
      ) : machines.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">
          No machines are available. <Link href="/owner/machines/new" className="text-primary hover:underline">Register a machine</Link> or
          return one first.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-background">
          {machines.map((m) => (
            <li key={m.id}>
              <Link
                href={`/owner/machines/${m.id}/assign?customer=${id}`}
                className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">
                      {m.brand} {m.model}
                    </span>
                    <MachineTypeBadge type={m.type} />
                  </div>
                  <p className="truncate font-mono text-sm text-muted-foreground">{m.serial_no}</p>
                </div>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
