import { FileText } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DisputeView, ReadingRecord } from "@/lib/disputes/service";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";

/**
 * A ticket's dispute for both portals (11.4, CP-06; decisions 47-49): the reason
 * and file, the fresh meter photo, the answer. The owner also sees the reading
 * record kept after the meter photo was deleted, and the answer buttons (children).
 */

const OUTCOME: Record<NonNullable<DisputeView["kind"]>, { owner: string; customer: string }> = {
  REJECTED: { owner: "Rejected", customer: "Not accepted" },
  CORRECTED: { owner: "Bill corrected", customer: "Bill corrected" },
  CREDIT: { owner: "Credit given", customer: "Credit given" },
  CANCELLED: { owner: "Ticket cancelled", customer: "Ticket cancelled" },
};

const counter = (c: string) => (c === "COLOUR" ? "Colour" : "B&W");

export function DisputeCard({
  dispute,
  audience,
  invoiceHref,
  record,
  children,
}: {
  dispute: DisputeView;
  audience: "owner" | "customer";
  /** "/owner/invoices" or "/customer/bills": where the corrected bill opens. */
  invoiceHref: string;
  record?: ReadingRecord | null;
  children?: ReactNode;
}) {
  const open = dispute.status === "OPEN";
  return (
    <Card className={open ? "border-destructive/50" : undefined} data-testid="dispute-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {audience === "owner" ? "Dispute" : "Your dispute"}
          <Badge variant={open ? "destructive" : "outline"} data-testid="dispute-status">
            {open ? (audience === "owner" ? "Waiting for your answer" : "Being looked at") : OUTCOME[dispute.kind ?? "REJECTED"][audience]}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-muted-foreground">
            {formatDateTime(dispute.raisedAt)}
            {dispute.invoiceNo ? ` · bill ${dispute.invoiceNo}` : ""}
          </p>
          <p className="mt-1 rounded-md bg-muted px-2 py-1 text-base whitespace-pre-wrap" data-testid="dispute-reason">
            {dispute.reason}
          </p>
        </div>
        {dispute.attachment && (
          <p>
            {dispute.attachment.url ? (
              <a href={dispute.attachment.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 font-medium text-primary underline underline-offset-4">
                <FileText className="size-4" aria-hidden /> {dispute.attachment.mime === "application/pdf" ? "Open the PDF" : "Open the photo"}
              </a>
            ) : (
              "A file is attached."
            )}
          </p>
        )}

        {audience === "owner" && record && (
          <div className="rounded-lg border p-3" data-testid="reading-record">
            <p className="font-medium">Reading on record</p>
            <ul className="mt-1 space-y-0.5">
              {record.readings.map((r) => (
                <li key={r.counter}>
                  {counter(r.counter)}: {formatCount(r.previous)} → {formatCount(r.current)}
                  {r.correctedFrom !== null ? ` (customer typed ${formatCount(r.correctedFrom)})` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">
              {record.source === "CUSTOMER" ? "Sent by the customer" : "Entered by the owner"} {formatDateTime(record.submittedAt)}
              {record.reviewedAt ? ` · confirmed ${formatDateTime(record.reviewedAt)}${record.reviewedBy ? ` by ${record.reviewedBy}` : ""}` : ""}
              {record.photoDeleted ? " · the meter photo was deleted on confirmation" : ""}
            </p>
          </div>
        )}

        {dispute.photo && (
          <div className="rounded-lg border p-3" data-testid="dispute-photo">
            <p className="font-medium">Fresh meter photo</p>
            {dispute.photo.receivedAt ? (
              <>
                <p className="text-muted-foreground">Sent {formatDateTime(dispute.photo.receivedAt)}</p>
                {dispute.photo.readings && (
                  <p data-testid="dispute-photo-readings">{dispute.photo.readings.map((r) => `${counter(r.counter_type)} ${formatCount(r.value)}`).join(", ")}</p>
                )}
                {audience === "owner" &&
                  (dispute.photo.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a 5-minute signed URL of a private photo
                    <img src={dispute.photo.url} alt="Fresh meter photo from the customer" className="mt-2 max-h-72 w-full rounded-lg border bg-black object-contain" />
                  ) : (
                    <p className="text-muted-foreground">The photo was deleted when the dispute ended.</p>
                  ))}
              </>
            ) : (
              <p className="text-muted-foreground">
                Asked for {formatDateTime(dispute.photo.requestedAt)}
                {dispute.photo.note ? `: ${dispute.photo.note}` : ""}. Not sent yet.
              </p>
            )}
          </div>
        )}

        {!open && (
          <div className="rounded-lg bg-primary/5 p-3" data-testid="dispute-answer">
            <p className="font-medium">
              {OUTCOME[dispute.kind ?? "REJECTED"][audience]}
              {dispute.resolvedAt ? ` · ${formatDateTime(dispute.resolvedAt)}` : ""}
            </p>
            {dispute.resolution && <p className="mt-1 whitespace-pre-wrap">{dispute.resolution}</p>}
            {dispute.kind === "CREDIT" && dispute.credit && <p className="mt-1">Credit: {formatRupees(dispute.credit.amountCents)}</p>}
            {dispute.kind === "REJECTED" && dispute.newDueDate && <p className="mt-1">New due date: {formatDate(dispute.newDueDate)}</p>}
            {dispute.replacement && (
              <p className="mt-1">
                Corrected bill:{" "}
                <Link href={`${invoiceHref}/${dispute.replacement.id}`} className="font-medium underline underline-offset-4">
                  {dispute.replacement.invoiceNo}
                </Link>
              </p>
            )}
          </div>
        )}
        {open && children}
      </CardContent>
    </Card>
  );
}
