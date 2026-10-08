import { ChevronRight, Search } from "lucide-react";
import Link from "next/link";

import { MachineStatusBadge, MachineTypeBadge } from "@/components/machines/machine-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MachineListRow } from "@/lib/machines/queries";
import { MACHINE_STATUS_LABEL, MACHINE_STATUSES, MACHINE_TYPE_LABEL, MACHINE_TYPES, type MachineListFilter } from "@/lib/machines/schemas";

const selectClass = "h-12 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base sm:w-40 sm:flex-none";

/** Search (brand, model, serial) + type and status filters. A plain GET form. */
export function MachineFilters({ filter }: { filter: MachineListFilter }) {
  return (
    <form method="get" role="search" className="mb-4 flex flex-col gap-2 lg:flex-row">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input name="q" defaultValue={filter.q} placeholder="Brand, model or serial number" aria-label="Search" className="h-12 pl-10 text-base" />
      </div>
      <div className="flex gap-2">
        <select name="type" defaultValue={filter.type ?? ""} aria-label="Type" className={selectClass}>
          <option value="">All types</option>
          {MACHINE_TYPES.map((t) => (
            <option key={t} value={t}>
              {MACHINE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filter.status ?? ""} aria-label="Status" className={selectClass}>
          <option value="">All statuses</option>
          {MACHINE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {MACHINE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
        Search
      </Button>
    </form>
  );
}

function rentedTo(m: MachineListRow) {
  return m.current ? m.current.customer.name : null;
}

/** Cards on a phone, a table from md up (MAC-01). */
export function MachineList({ machines, empty }: { machines: MachineListRow[]; empty: string }) {
  if (machines.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <>
      <ul className="divide-y overflow-hidden rounded-xl border bg-background md:hidden" aria-label="Machines">
        {machines.map((m) => (
          <li key={m.id}>
            <Link href={`/owner/machines/${m.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">
                    {m.brand} {m.model}
                  </span>
                  <MachineStatusBadge status={m.status} />
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {[m.serial_no, MACHINE_TYPE_LABEL[m.type], rentedTo(m)].filter(Boolean).join(" · ")}
                </p>
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-xl border bg-background md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Machine</th>
              <th className="px-4 py-3 font-medium">Serial number</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Customer</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {machines.map((m) => (
              <tr key={m.id} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link href={`/owner/machines/${m.id}`} className="font-medium hover:underline">
                    {m.brand} {m.model}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono">{m.serial_no}</td>
                <td className="px-4 py-3">
                  <MachineTypeBadge type={m.type} />
                </td>
                <td className="px-4 py-3">
                  <MachineStatusBadge status={m.status} />
                </td>
                <td className="px-4 py-3">
                  {m.current ? (
                    <Link href={`/owner/customers/${m.current.customer.id}`} className="hover:underline">
                      {m.current.customer.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
