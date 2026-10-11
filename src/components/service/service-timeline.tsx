import { formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import type { TrailEntry } from "@/lib/service/queries";
import { STATUS_LABEL } from "@/lib/service/states";

import { Stars } from "./service-display";

/**
 * The request's status trail (SRV-05): every status change, assignment, note,
 * escalation, charge and rating, oldest first. The customer sees the same trail
 * without who escalated it (escalations are between the owner and the platform).
 */

function title(e: TrailEntry, audience: "OWNER" | "CUSTOMER"): string {
  const m = e.metadata;
  switch (e.kind) {
    case "NOTE":
      return "Note";
    case "ASSIGNMENT":
      return `Technician: ${String(m.technician ?? "")}`;
    case "ESCALATION":
      return Number(m.level) >= 2 ? "Not acknowledged in time: admin alerted" : "Not acknowledged in time: reminder sent";
    case "RATING":
      return "Rated";
    case "CHARGE":
      return "Charge removed";
    default:
      if (!e.from) return audience === "CUSTOMER" ? "Request sent" : "Request raised";
      if (e.from === "RESOLVED" && e.to === "IN_PROGRESS") return "Still not fixed: reopened";
      if (e.to === "CLOSED" && m.confirmed_by_customer) return "Closed: the customer confirmed the fix";
      if (e.to === "ASSIGNED") return `Assigned to ${String(m.technician ?? "a technician")}`;
      return STATUS_LABEL[e.to];
  }
}

function details(e: TrailEntry): string[] {
  const m = e.metadata;
  const out: string[] = [];
  if ((e.kind === "ASSIGNMENT" || e.to === "ASSIGNED") && m.planned_date) out.push(`Planned visit: ${formatDate(String(m.planned_date))}`);
  if (e.kind === "STATUS" && e.to === "RESOLVED") {
    if (m.work_done) out.push(`Work done: ${String(m.work_done)}`);
    if (m.parts_used) out.push(`Parts used: ${String(m.parts_used)}`);
    if (typeof m.charge_cents === "number") out.push(`Charge on the next bill: ${formatRupees(m.charge_cents)} (${String(m.charge_description ?? "")})`);
    if (typeof m.discount_cents === "number") out.push(`Discount (credit for the next bills): ${formatRupees(m.discount_cents)} (${String(m.discount_description ?? "")})`);
  }
  if (e.kind === "CHARGE" && typeof m.removed_cents === "number") out.push(`${formatRupees(m.removed_cents)} (${String(m.description ?? "")}) will not be billed`);
  return out;
}

export function ServiceTimeline({ entries, audience }: { entries: TrailEntry[]; audience: "OWNER" | "CUSTOMER" }) {
  return (
    <ol className="space-y-4 border-l-2 border-muted pl-4" aria-label="History" data-testid="service-timeline">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute top-1.5 -left-[1.4rem] size-2.5 rounded-full bg-primary" aria-hidden />
          <p className="font-medium">
            {title(e, audience)}
            {e.kind === "RATING" && typeof e.metadata.rating === "number" && <Stars rating={e.metadata.rating} className="ml-2" />}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(e.at)}
            {e.by ? ` · ${e.by.role === "CUSTOMER" ? (audience === "CUSTOMER" ? "you" : e.by.name) : audience === "CUSTOMER" ? "your rental company" : e.by.name}` : " · RentDesk"}
          </p>
          {e.note && <p className="mt-1 text-sm whitespace-pre-line">{e.note}</p>}
          {details(e).map((d) => (
            <p key={d} className="mt-1 text-sm text-muted-foreground">
              {d}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}
