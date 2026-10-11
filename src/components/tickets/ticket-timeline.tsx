import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import type { TicketDetail } from "@/lib/tickets/queries";

type Event = TicketDetail["events"][number];

const status = (s: string | null) => (s ? (TICKET_STATUS_LABEL[s] ?? s) : "");
const counter = (c: unknown) => (c === "COLOUR" ? "Colour" : "B&W");

/** Shared by both timelines: the note-type events of disputes and invoices (decisions 47-54). */
export function describeNote(m: Record<string, unknown>, audience: "owner" | "customer"): string | null {
  switch (m.kind) {
    case "PHOTO_REQUESTED":
      return audience === "owner" ? "Fresh meter photo asked for" : "Your rental company asked for a fresh meter photo";
    case "PHOTO_RECEIVED": {
      const readings = (m.readings as { counter_type: string; value: number }[] | undefined) ?? [];
      const text = readings.map((r) => `${counter(r.counter_type)} ${formatCount(r.value)}`).join(", ");
      return `Fresh meter photo sent${text ? `: ${text}` : ""}`;
    }
    case "INVOICE_RESENT":
      return `Bill ${m.invoice_no ?? ""} sent again`;
    default:
      return null;
  }
}

/** A corrected invoice (cancel and reissue, decision 49). */
export function describeCorrection(m: Record<string, unknown>): string {
  const totals = m.total_from !== undefined ? `: ${formatRupees(Number(m.total_from))} → ${formatRupees(Number(m.total_to ?? 0))}` : "";
  return m.replaces_invoice_no ? `Bill corrected: ${m.replaces_invoice_no} cancelled, ${m.invoice_no} issued${totals}` : "Reading corrected";
}

/** A new meter baseline (decision 51). */
export function describeBaseline(m: Record<string, unknown>): string {
  const counters = (m.counters as { counter_type: string; value: number; carried_copies: number }[] | undefined) ?? [];
  const text = counters
    .map((c) => `${counter(c.counter_type)} from ${formatCount(c.value)}${c.carried_copies ? ` (${formatCount(c.carried_copies)} copies on the old meter carried)` : ""}`)
    .join(", ");
  return `New meter recorded${text ? `: ${text}` : ""}`;
}

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
    case "CORRECTION":
      return describeCorrection(m);
    case "BASELINE":
      return describeBaseline(m);
    case "NOTE":
      return describeNote(m, "owner") ?? "Note";
    case "PAYMENT":
      // A reversal or a move that left the status as it was (decision 42).
      return `Payment ${m.reversed_cents ? "reversed" : m.moved_from_cents !== undefined ? "moved" : "changed"}: paid ${formatRupees(Number(m.paid_cents ?? 0))} (was ${formatRupees(Number(m.paid_before_cents ?? 0))})`;
    default:
      if (m.estimated && e.to_status === "PENDING_OWNER_REVIEW") return "Estimated invoice created for review";
      if (e.from_status === "DISPUTED" && m.dispute_outcome === "REJECTED")
        return `Dispute rejected${m.due_date_to && m.due_date_to !== m.due_date_from ? `; new due date ${formatDate(String(m.due_date_to))}` : ""}`;
      if (e.from_status === "DISPUTED" && m.dispute_outcome === "CREDIT") return `Credit of ${formatRupees(Number(m.credit_cents ?? 0))} given for the dispute`;
      if (e.to_status === "DISPUTED") return "Bill disputed by the customer";
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
