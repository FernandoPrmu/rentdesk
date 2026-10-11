import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { CustomerRequestActions, RatingForm } from "@/components/service/customer-request-actions";
import { requestTitle, ServiceStatusBadge, Stars, UrgencyBadge } from "@/components/service/service-display";
import { ServiceTimeline } from "@/components/service/service-timeline";
import { Card, CardContent } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { daysDown } from "@/lib/service/rules";
import { getRequest } from "@/lib/service/queries";

import { customerServiceStepAction, rateServiceAction } from "../actions";

export const metadata: Metadata = { title: "Service request" };

/** SRV-05 / CP-07: a request's status, who handles it, the timeline, the photo, the fix to confirm and the rating. */
export default async function CustomerRequestPage({ params }: PageProps<"/customer/service/[id]">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const r = await getRequest(id);
  if (!r) return deniedNotFound(user, "service_requests", id, "/customer/service/[id]");

  const nextStep: Record<string, string> = {
    NEW: "Sent. Your rental company will look at it soon.",
    ACKNOWLEDGED: "Your rental company has seen it and will send someone.",
    ASSIGNED: r.technician ? `${r.technician} will handle it${r.plannedDate ? ` (visit planned for ${formatDate(r.plannedDate)})` : ""}.` : "A technician is assigned.",
    IN_PROGRESS: "Work has started.",
    RESOLVED: "Your rental company says it is done. Please check.",
    CLOSED: "Done.",
    CANCELLED: r.cancelReason ? `Cancelled: ${r.cancelReason}` : "Cancelled.",
  };

  return (
    <div className="space-y-5">
      <div>
        <BackLink href="/customer/service" label="My requests" />
        <div className="flex flex-wrap items-center gap-2">
          <ServiceStatusBadge status={r.status} />
          <UrgencyBadge urgency={r.urgency} />
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">{requestTitle(r)}</h1>
        <p className="text-muted-foreground">
          {r.machine.name} · {r.machine.serialNo}
        </p>
        <p className="mt-2 font-medium" data-testid="service-next">
          {nextStep[r.status]}
        </p>
      </div>

      <CustomerRequestActions requestId={r.id} status={r.status} action={customerServiceStepAction} />
      {r.status === "CLOSED" && r.rating === null && <RatingForm requestId={r.id} action={rateServiceAction} />}

      <Card>
        <CardContent className="space-y-2 text-sm">
          <p className="whitespace-pre-line">{r.description}</p>
          <p className="text-muted-foreground">Sent {formatDateTime(r.createdAt)}</p>
          {r.preferredDate && <p className="text-muted-foreground">Preferred date: {formatDate(r.preferredDate)}</p>}
          {r.type === "BREAKDOWN" && r.resolvedAt && <p className="text-muted-foreground">Fixed after {daysDown(r.createdAt, r.resolvedAt)} day(s)</p>}
          {r.workDone && (
            <p>
              <span className="font-medium">Work done:</span> {r.workDone}
            </p>
          )}
          {r.partsUsed && (
            <p>
              <span className="font-medium">Parts:</span> {r.partsUsed}
            </p>
          )}
          {r.charge && (
            <p className="rounded-lg bg-muted px-3 py-2" data-testid="service-charge">
              {formatRupees(r.charge.amountCents)} ({r.charge.description}){" "}
              {r.charge.invoice?.invoiceNo ? `is on bill ${r.charge.invoice.invoiceNo}.` : "will be added to your next bill."}
            </p>
          )}
          {r.discount && (
            <p className="rounded-lg bg-muted px-3 py-2">
              {formatRupees(r.discount.amountCents)} discount: taken off your next bills.
            </p>
          )}
          {r.rating !== null && (
            <p>
              Your rating: <Stars rating={r.rating} />
              {r.ratingComment ? ` “${r.ratingComment}”` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      {r.photo?.url && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Your photo</h2>
          {/* eslint-disable-next-line @next/next/no-img-element -- a 5-minute signed link to a private file */}
          <img src={r.photo.url} alt="The photo you sent with the request" className="max-h-80 w-full rounded-xl border object-contain" data-testid="service-photo" />
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        <ServiceTimeline entries={r.trail} audience="CUSTOMER" />
      </section>
    </div>
  );
}
