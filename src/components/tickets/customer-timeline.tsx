import { formatCount, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import type { CustomerTicketDetail } from "@/lib/tickets/queries";

type Event = CustomerTicketDetail["events"][number];

/** The customer's view of a ticket's history (CP-02): plain words, nothing internal (escalations are left out). */
function describe(e: Event): string | null {
  const m = (e.metadata ?? {}) as Record<string, unknown>;
  switch (e.event_type) {
    case "CREATED":
      return "Meter reading requested";
    case "REMINDER":
      return "Reminder sent";
    case "ESCALATION":
      return null;
    case "LATE_FEE":
      return `Late fee of ${formatRupees(Number(m.late_fee_cents ?? 0))} added`;
    case "PAUSED":
      return "On hold";
    case "RESUMED":
      return "Active again; deadlines moved forward";
    case "MANUAL_ENTRY":
      return "Your rental company entered the reading";
    case "CORRECTION": {
      const changes = (m.changes as { counter_type: string; from: number; to: number }[] | undefined) ?? [];
      const text = changes.map((c) => `${c.counter_type === "BW" ? "B&W" : "Colour"} ${formatCount(c.from)} → ${formatCount(c.to)}`).join(", ");
      return `Reading corrected${text ? `: ${text}` : ""}`;
    }
    default:
      switch (e.to_status) {
        case "PENDING_OWNER_REVIEW":
          return m.estimated ? "Estimated bill prepared (no reading received)" : "Reading sent";
        case "METER_REQUESTED":
          return "Reading not accepted; please send it again";
        case "AWAITING_PAYMENT":
          return e.from_status === "PENDING_OWNER_REVIEW" ? `Bill issued${m.invoice_no ? ` (${m.invoice_no})` : ""}` : "Waiting for payment";
        case "OVERDUE":
          return "Deadline passed";
        case "PAYMENT_SUBMITTED":
          return "Payment slip sent";
        case "PARTIALLY_PAID":
          return "Part payment accepted";
        case "CLOSED":
          return "Paid. Thank you";
        case "DISPUTED":
          return "Dispute sent";
        case "CANCELLED":
          return "Cancelled";
        case "REOPENED":
          return "Reopened";
        default:
          return null;
      }
  }
}

export function CustomerTimeline({ events, customerId }: { events: Event[]; customerId: string }) {
  const rows = events.map((e) => ({ e, text: describe(e) })).filter((r): r is { e: Event; text: string } => r.text !== null);
  if (rows.length === 0) return null;
  return (
    <ol className="relative space-y-4 border-l pl-5" aria-label="History" data-testid="customer-timeline">
      {rows.map(({ e, text }) => (
        <li key={e.id} className="relative">
          <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-primary" aria-hidden />
          <p className="font-medium">{text}</p>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(e.created_at)} · {e.actor_id === customerId ? "You" : e.actor_id ? "Your rental company" : "RentDesk"}
          </p>
          {e.reason && e.event_type !== "CREATED" && <p className="mt-1 rounded-md bg-muted px-2 py-1 text-sm">{e.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
