import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { confirmReviewAction, correctReadingAction, rejectReviewAction, setCreditAction } from "@/app/(owner)/owner/tickets/actions";
import { PhotoViewer } from "@/components/meter/photo-viewer";
import { ReviewPanel } from "@/components/meter/review-panel";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { ANOMALY_WARNING } from "@/lib/meter/readings";
import { getReview } from "@/lib/meter/service";
import { formatRupees } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Review reading" };

/**
 * INV-07..09 / spec 6.1 step 4: the photo next to the typed reading(s), usage and
 * flags, the draft invoice with its credits, then confirm, correct or reject. An
 * estimated invoice (no reading arrived, spec 11.6) is reviewed here too.
 */
export default async function ReviewPage({ params }: PageProps<"/owner/tickets/[id]/review">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const view = await getReview(owner, id, await createClient());
  if (!view) notFound();
  const t = view.ticket;
  const inv = view.invoice;
  const sub = view.submission;
  const estimated = inv?.type === "ESTIMATED";

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href={`/owner/tickets/${t.id}`} label="Ticket" />
        <PageHeader title={estimated ? "Review estimated invoice" : "Review reading"} description={`${t.customer_name} · ${t.machine_name} (${t.serial_no}) · cycle ${t.cycle_no}`} />
      </div>

      {!inv ? (
        <Card>
          <CardContent className="space-y-3">
            <p data-testid="review-nothing">Nothing is waiting for your review on this ticket.</p>
            <Link href={`/owner/tickets/${t.id}`} className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
              Back to the ticket
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {estimated && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
              No meter reading arrived by the deadline, so this estimate bills the monthly commitment only. The next real reading measures from the
              last confirmed reading and credits this charge (spec 11.6).
            </p>
          )}

          {sub && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{sub.source === "OWNER_MANUAL" ? "Entered by you" : "Photo"}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  {view.photo?.url ? (
                    <PhotoViewer url={view.photo.url} alt={`Meter photo from ${t.customer_name}`} />
                  ) : (
                    <p className="text-muted-foreground">{sub.source === "OWNER_MANUAL" ? "No photo: you entered this reading." : "The photo is no longer available."}</p>
                  )}
                  {view.photo && (
                    <p className="text-muted-foreground">
                      {view.photo.capturedAt ? `Taken ${formatDateTime(view.photo.capturedAt)} · ` : ""}received {formatDateTime(view.photo.uploadedAt)}
                    </p>
                  )}
                  {sub.note && <p className="rounded-md bg-muted px-2 py-1">{sub.note}</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Reading</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <ul className="space-y-3" data-testid="review-readings">
                    {sub.readings.map((r) => (
                      <li key={r.counter}>
                        <p className="text-sm text-muted-foreground">{r.counter === "BW" ? (t.machine_type === "COLOUR" ? "B&W counter" : "Meter") : "Colour counter"}</p>
                        <p className="text-2xl font-semibold tabular-nums">{formatCount(r.current)}</p>
                        <p className="text-sm text-muted-foreground">
                          Previous {formatCount(r.previous)} · {r.rolledOver ? "counter went past its maximum" : `used ${formatCount(r.current - r.previous)}`}
                        </p>
                        {r.correctedFrom !== null && (
                          <p className="text-sm">
                            Corrected from {formatCount(r.correctedFrom)}: {r.correctionNote}
                          </p>
                        )}
                        {r.rolledOver && <Badge variant="destructive">Counter rollover</Badge>}
                      </li>
                    ))}
                  </ul>
                  {sub.anomaly && (
                    <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm font-medium" data-testid="review-anomaly">
                      {ANOMALY_WARNING[sub.anomaly]} Compare with the photo.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Sent {formatDateTime(sub.submittedAt)} · attempt {sub.attemptNo}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Draft invoice</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1 text-sm" data-testid="review-lines">
                {inv.lines.map((l) => (
                  <div key={l.id} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{l.description}</dt>
                    <dd className="tabular-nums">{formatRupees(l.amount_cents)}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-3 border-t pt-2 text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums" data-testid="review-total">
                    {formatRupees(inv.totalCents)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-sm text-muted-foreground">If you confirm now, it is due on {formatDate(view.dueDate)}.</p>
            </CardContent>
          </Card>

          <ReviewPanel
            ticketId={t.id}
            invoiceId={inv.id}
            estimated={estimated}
            machineType={t.machine_type}
            readings={sub?.readings ?? []}
            credits={view.credits}
            rolloverToConfirm={view.rolloverToConfirm}
            finalRejection={sub !== null && view.rejectionCount + 1 >= view.maxRejections}
            context={view.context}
            actions={{ confirm: confirmReviewAction, reject: rejectReviewAction, correct: correctReadingAction, setCredit: setCreditAction }}
          />
        </>
      )}
    </div>
  );
}
