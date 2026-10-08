import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { MachineFilters, MachineList } from "@/components/machines/machine-list";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { listMachines } from "@/lib/machines/queries";
import { machineListFilterSchema } from "@/lib/machines/schemas";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Machines" };

export default async function MachinesPage({ searchParams }: PageProps<"/owner/machines">) {
  await requireUser("OWNER");
  const filter = machineListFilterSchema.parse(await searchParams);
  const machines = await listMachines(filter);
  const filtered = Boolean(filter.q || filter.type || filter.status);

  return (
    <>
      <PageHeader
        title="Machines"
        action={
          <Link href="/owner/machines/new" className={cn(buttonVariants(), "h-12 gap-2 px-5 text-base")}>
            <Plus className="size-5" aria-hidden /> New machine
          </Link>
        }
      />
      <MachineFilters filter={filter} />
      <MachineList machines={machines} empty={filtered ? "No machines match this search." : "No machines yet. Register the first one."} />
    </>
  );
}
