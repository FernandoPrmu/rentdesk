import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { OwnerRequestActions } from "@/components/service/owner-request-actions";
import { EscalatedBadge, OverdueBadge, requestTitle, ServiceStatusBadge, Stars, UrgencyBadge } from "@/components/service/service-display";
import { ServiceTimeline } from "@/components/service/service-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { daysDown } from "@/lib/service/rules";
import { getRequest } from "@/lib/service/queries";
import { createClient } from "@/lib/supabase/server";

import { ownerServiceStepAction } from "../actions";

export const metadata: Metadata = { title: "Service request" };

/** SRV-03..09: one request with its photo, work, charge, rating, trail and the owner's next step. */
export default async function OwnerRequestPage({ params }: PageProps<"/owner/service/[id]">) {
  const user = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const r = await getRequest(id, { withCost: true });
  if (!r) return deniedNotFound(user, "service_requests", id, "/owner/service/[id]");
  const supabase = await createClient();
  const { data: agreement } = r.agreementId ? await supabase.from("rental_agreements").select("status").eq("id", r.agreementId).maybeSingle() : { data: null };

  return (
    <div className="space-y-5">
      <div>
        <BackLink href="/owner/service" label="Service requests" />
        <div className="flex flex-wrap items-center gap-2">
          <ServiceStatusBadge status={r.status} />
          <UrgencyBadge urgency={r.urgency} />
          {r.overdue && <OverdueBadge />}
          {r.status === "NEW" && <EscalatedBadge level={r.escalationLevel} />}
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{requestTitle(r)}</h1>
        <p className="text-muted-foreground">
          <Link href={`/owner/customers/${r.customer.id}`} className="font-medium text-primary hover:underline">
            {r.customer.name}
          </Link>{" "}
          ·{" "}
          <Link href={`/owner/machines/${r.machine.id}`} className="font-medium text-primary hover:underline">
            {r.machine.name} ({r.machine.serialNo})
          </Link>
        </p>
        <p className="text-sm text-muted-foreground">
          Raised {formatDateTime(r.createdAt)}
          {r.status === "NEW" && ` · acknowledge by ${formatDateTime(r.acknowledgeBy)}`}
        </p>
      </div>

      <OwnerRequestActions
        requestId={r.id}
        status={r.status}
        type={r.type}
        today={todayInColombo()}
        technician={r.technician}
        plannedDate={r.plannedDate}
        hasCharge={Boolean(r.charge)}
        hasDiscount={Boolean(r.discount)}
        chargeAllowed={agreement?.status !== undefined && agreement.status !== "TERMINATED"}
        action={ownerServiceStepAction}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="whitespace-pre-line">{r.description}</p>
            {r.preferredDate && <p className="text-muted-foreground">Preferred date: {formatDate(r.preferredDate)}</p>}
            {r.technician && (
              <p>
                <span className="font-medium">Technician:</span> {r.technician}
                {r.plannedDate ? ` · visit ${formatDate(r.plannedDate)}` : ""}
              </p>
            )}
            {r.reopenCount > 0 && <p className="font-medium text-destructive">Reopened {r.reopenCount} time(s): the customer said it was still not fixed.</p>}
            {r.photo?.url && (
              // eslint-disable-next-line @next/next/no-img-element -- a 5-minute signed link to a private file
              <img src={r.photo.url} alt="Photo the customer sent" className="mt-2 max-h-80 w-full rounded-xl border object-contain" data-testid="service-photo" />
            )}
          </CardContent>
        </Card>
        {(r.workDone || r.charge || r.discount || r.rating !== null) && (
          <Card>
            <CardHeader>
              <CardTitle>Work and outcome</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {r.workDone && (
                <p>
                  <span className="font-medium">Work done:</span> {r.workDone}
                </p>
              )}
              {r.partsUsed && (
                <p>
                  <span className="font-medium">Parts used:</span> {r.partsUsed}
                </p>
              )}
              {r.costCents !== null && (
                <p>
                  <span className="font-medium">Cost (yours):</span> {formatRupees(r.costCents)}
                </p>
              )}
              {r.type === "BREAKDOWN" && <p className="text-muted-foreground">Machine down for {daysDown(r.createdAt, r.resolvedAt)} day(s)</p>}
              {r.charge && (
                <p data-testid="service-charge">
                  <span className="font-medium">Charge:</span> {formatRupees(r.charge.amountCents)} ({r.charge.description}) ·{" "}
                  {r.charge.invoice ? (
                    <Link href={`/owner/invoices/${r.charge.invoice.id}`} className="text-primary hover:underline">
                      {r.charge.invoice.invoiceNo ? `on bill ${r.charge.invoice.invoiceNo}` : "on a bill waiting for your review"}
                    </Link>
                  ) : (
                    "waiting for the next bill"
                  )}
                </p>
              )}
              {r.discount && (
                <p>
                  <span className="font-medium">Discount:</span> {formatRupees(r.discount.amountCents)} as a credit ({r.discount.status.toLowerCase()})
                </p>
              )}
              {r.rating !== null && (
                <p data-testid="service-rating">
                  <span className="font-medium">Customer rating:</span> <Stars rating={r.rating} />
                  {r.ratingComment ? ` “${r.ratingComment}”` : ""}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        <ServiceTimeline entries={r.trail} audience="OWNER" />
      </section>
    </div>
  );
}
