import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { formatDate, formatDateTime } from "@/lib/format";
import type { ServiceRow } from "@/lib/service/queries";
import { isPriority } from "@/lib/service/states";
import { cn } from "@/lib/utils";

import { EscalatedBadge, OverdueBadge, requestTitle, ServiceStatusBadge, Stars, UrgencyBadge } from "./service-display";

/**
 * Service requests as cards (phones) and a table (owner, md and up). URGENT and
 * HIGH open requests carry a coloured edge (decision 62); the list is already sorted.
 */
export function RequestList({
  rows,
  hrefBase,
  showCustomer,
  showMachine = true,
  empty,
  label = "Service requests",
  table = showCustomer,
}: {
  rows: ServiceRow[];
  hrefBase: "/owner/service" | "/customer/service";
  showCustomer: boolean;
  showMachine?: boolean;
  empty: string;
  label?: string;
  /** A table from md up (the owner's full list); cards everywhere otherwise. */
  table?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  const edge = (r: ServiceRow) =>
    ["CLOSED", "CANCELLED"].includes(r.status) ? "" : r.urgency === "URGENT" ? "border-l-4 border-l-red-600" : r.urgency === "HIGH" ? "border-l-4 border-l-orange-500" : "";
  return (
    <>
      <ul className={cn("space-y-3", table && "md:hidden")} aria-label={label}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`${hrefBase}/${r.id}`} className={cn("block rounded-xl border bg-background p-4", edge(r))} data-testid="service-card">
              <div className="flex flex-wrap items-center gap-2">
                <ServiceStatusBadge status={r.status} />
                <UrgencyBadge urgency={r.urgency} quiet />
                {r.overdue && <OverdueBadge />}
                {r.status === "NEW" && <EscalatedBadge level={r.escalationLevel} />}
              </div>
              <p className="mt-2 font-semibold">{requestTitle(r)}</p>
              <p className="truncate text-sm text-muted-foreground">
                {[showCustomer ? r.customer.name : null, showMachine ? `${r.machine.name} (${r.machine.serialNo})` : null].filter(Boolean).join(" · ")}
              </p>
              <p className="mt-1 flex items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>
                  {formatDateTime(r.createdAt)}
                  {r.technician ? ` · ${r.technician}` : ""}
                  {r.plannedDate ? ` · visit ${formatDate(r.plannedDate)}` : ""}
                </span>
                {r.rating !== null ? <Stars rating={r.rating} /> : <ChevronRight className="size-5 shrink-0" aria-hidden />}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      {table && (
        <div className="hidden overflow-x-auto rounded-xl border bg-background md:block">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Raised</th>
                <th className="px-3 py-2 font-medium">Request</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Machine</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Technician</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className={cn(isPriority(r.urgency) && !["CLOSED", "CANCELLED"].includes(r.status) && "bg-red-50/60 dark:bg-red-950/20")}>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2">
                    <Link href={`${hrefBase}/${r.id}`} className="font-medium text-primary hover:underline">
                      {requestTitle(r)}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <UrgencyBadge urgency={r.urgency} quiet />
                      {r.overdue && <OverdueBadge />}
                      {r.status === "NEW" && <EscalatedBadge level={r.escalationLevel} />}
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.customer.name}</td>
                  <td className="px-3 py-2">
                    {r.machine.name}
                    <span className="block text-xs text-muted-foreground">{r.machine.serialNo}</span>
                  </td>
                  <td className="px-3 py-2">
                    <ServiceStatusBadge status={r.status} />
                    {r.rating !== null && <Stars rating={r.rating} className="ml-2" />}
                  </td>
                  <td className="px-3 py-2">
                    {r.technician ?? "—"}
                    {r.plannedDate && <span className="block text-xs text-muted-foreground">visit {formatDate(r.plannedDate)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
