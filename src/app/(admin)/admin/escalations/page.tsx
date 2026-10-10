import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { dueText, TicketStatusBadge } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { listEscalations } from "@/lib/tickets/queries";
import { currentDue, nextStep } from "@/lib/tickets/view";

export const metadata: Metadata = { title: "Escalations" };

/**
 * Tickets escalated to the platform (spec 5.4): an owner has not reviewed a
 * reading or a payment slip in time. Read-only: the admin follows up with the
 * owner; the ticket stays with them.
 */
export default async function EscalationsPage() {
  await requireUser("ADMIN");
  const tickets = await listEscalations();

  return (
    <>
      <PageHeader title="Escalations" description="Owners who have not reviewed a meter reading or a payment slip in time." />
      {tickets.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">Nothing escalated right now.</p>
      ) : (
        <ul className="space-y-3" aria-label="Escalated tickets">
          {tickets.map((t) => (
            <li key={t.id} className="rounded-xl border bg-background p-4" data-testid="escalation">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{t.owner.business_name}</span>
                <TicketStatusBadge status={t.status} before={t.status_before_overdue} />
              </div>
              <p className="text-sm text-muted-foreground">
                {t.customer.name} · {t.machine.brand} {t.machine.model} · cycle {t.cycle_no} ({formatDate(t.cycle_date)})
              </p>
              <p className="mt-1 text-sm">
                Owner to: {nextStep(t).label.toLowerCase()} · waiting since {formatDateTime(t.stage_entered_at)} · {dueText(currentDue(t))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
