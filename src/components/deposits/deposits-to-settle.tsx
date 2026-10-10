import Link from "next/link";

import type { DepositToSettle } from "@/lib/deposits/queries";
import { formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";

/**
 * Client decision 2: deposits kept when a machine was returned, still to be
 * settled (owner dashboard, customer profile). Each links to the agreement, where
 * the owner deducts, refunds or keeps it.
 */
export function DepositsToSettle({ items, empty }: { items: DepositToSettle[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y text-sm" aria-label="Deposits to settle">
      {items.map((d) => (
        <li key={d.agreementId}>
          <Link href={`/owner/agreements/${d.agreementId}`} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2 hover:underline">
            <span>
              <span className="font-medium">{d.customer.name}</span> · {d.machine.brand} {d.machine.model} ({d.machine.serial_no})
              {d.terminatedAt ? <span className="block text-xs text-muted-foreground">Returned {formatDateTime(d.terminatedAt)}</span> : null}
            </span>
            <span className="font-semibold tabular-nums">{formatRupees(d.heldCents)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
