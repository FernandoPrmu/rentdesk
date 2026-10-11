import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { requestTitle, UrgencyBadge } from "@/components/service/service-display";
import { dueText, TicketStatusBadge } from "@/components/tickets/ticket-display";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { listServiceEscalations } from "@/lib/service/queries";
import { listEscalations } from "@/lib/tickets/queries";
import { currentDue, nextStep } from "@/lib/tickets/view";

export const metadata: Metadata = { title: "Escalations" };

/**
 * Work escalated to the platform (spec 5.4, 7.3): an owner has not reviewed a
 * reading or a payment slip in time, or has not acknowledged a service request
 * (SRV-08). Read-only: the admin follows up with the owner; the work stays with them.
 */
export default async function EscalationsPage() {
  await requireUser("ADMIN");
  const [tickets, requests] = await Promise.all([listEscalations(), listServiceEscalations()]);

  return (
    <>
      <PageHeader title="Escalations" description="Owners who have not acted in time on a billing ticket or a service request." />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Billing tickets</h2>
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
      </section>
      <section className="mt-6 space-y-3">
        <h2 className="text-lg font-semibold">Service requests not acknowledged</h2>
        {requests.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">Nothing escalated right now.</p>
        ) : (
          <ul className="space-y-3" aria-label="Escalated service requests">
            {requests.map((r) => (
              <li key={r.id} className="rounded-xl border bg-background p-4" data-testid="service-escalation">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.owner.business_name}</span>
                  <UrgencyBadge urgency={r.urgency} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {r.customer.name} · {r.machine.name} ({r.machine.serialNo}) · {requestTitle(r)}
                </p>
                <p className="mt-1 text-sm">
                  Raised {formatDateTime(r.createdAt)}
                  {r.escalatedAt ? ` · escalated ${formatDateTime(r.escalatedAt)}` : ""} · still not acknowledged
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
