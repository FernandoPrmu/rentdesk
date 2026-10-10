import { formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import type { TicketDetail } from "@/lib/tickets/queries";

type Event = TicketDetail["events"][number];

const status = (s: string | null) => (s ? (TICKET_STATUS_LABEL[s] ?? s) : "");

/** One line per ticket_events row, in plain words (TKT-06, TKT-09). */
function describe(e: Event): string {
  const m = (e.metadata ?? {}) as Record<string, unknown>;
  switch (e.event_type) {
    case "CREATED":
      return `Ticket opened: cycle ${m.cycle_no ?? ""}${m.cycle_date ? ` (${formatDate(String(m.cycle_date))})` : ""}`;
    case "REMINDER":
      return `Reminder ${m.reminder_no ?? ""} sent`;
    case "ESCALATION":
      return Number(m.level) >= 2 ? "Escalated to the platform admin" : "Escalated to the owner";
    case "LATE_FEE":
      return `Late fee of ${formatRupees(Number(m.late_fee_cents ?? 0))} added`;
    case "PAUSED":
      return "Paused";
    case "RESUMED":
      return `Resumed${m.paused_days ? ` after ${m.paused_days} days; deadlines moved forward` : ""}`;
    case "MANUAL_ENTRY":
      return `Reading entered by the owner: ${status(e.from_status)} → ${status(e.to_status)}`;
    default:
      if (m.estimated && e.to_status === "PENDING_OWNER_REVIEW") return "Estimated invoice created for review";
      if (e.from_status && e.to_status && e.from_status !== e.to_status) return `${status(e.from_status)} → ${status(e.to_status)}`;
      return status(e.to_status) || e.event_type;
  }
}

function actorName(e: Event) {
  if (!e.actor) return "System";
  return e.actor.full_name || e.actor.username;
}

export function TicketTimeline({ events }: { events: Event[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No history yet.</p>;
  return (
    <ol className="relative space-y-4 border-l pl-5" aria-label="Ticket history" data-testid="ticket-timeline">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-primary" aria-hidden />
          <p className="font-medium">{describe(e)}</p>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(e.created_at)} · {actorName(e)}
          </p>
          {e.reason && <p className="mt-1 rounded-md bg-muted px-2 py-1 text-sm">{e.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
