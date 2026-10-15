import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import type { MeterHistoryRow } from "@/lib/machines/queries";

const COUNTER_LABEL: Record<string, string> = { BW: "B&W", COLOUR: "Colour" };
const SOURCE_LABEL: Record<string, string> = { CUSTOMER: "Customer's photo", OWNER_MANUAL: "Entered by you" };

/** MAC-05: confirmed readings per cycle on the machine page, each linking to its ticket. */
export function MeterHistory({ rows }: { rows: MeterHistoryRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No confirmed meter readings for this machine yet.</p>;
  return (
    <ul className="divide-y" aria-label="Meter history" data-testid="meter-history">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/owner/tickets/${r.ticket.id}`} className="flex items-center gap-3 py-3 hover:bg-muted/50">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                Cycle {r.ticket.cycle_no} · {formatDate(r.ticket.period_start)} to {formatDate(r.ticket.period_end)}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.ticket.customer.name} · {SOURCE_LABEL[r.source] ?? r.source}
                {r.reviewed_at && ` · confirmed ${formatDateTime(r.reviewed_at)}`}
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {[...r.readings]
                  .sort((a, b) => a.counter_type.localeCompare(b.counter_type))
                  .map((m) => (
                    <div key={m.counter_type} className="flex gap-1">
                      <dt className="text-muted-foreground">{COUNTER_LABEL[m.counter_type] ?? m.counter_type}:</dt>
                      <dd className="tabular-nums">
                        {m.previous_value === null ? "" : `${formatCount(m.previous_value)} → `}
                        {formatCount(m.current_value)}
                        {m.corrected_from_value !== null && <span className="text-muted-foreground"> (typed {formatCount(m.corrected_from_value)})</span>}
                        {m.rolled_over && <span className="text-muted-foreground"> (counter rolled over)</span>}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
