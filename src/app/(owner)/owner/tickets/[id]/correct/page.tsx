import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CorrectionForm } from "@/components/invoices/correction-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { getCorrectionView } from "@/lib/invoices/correction";
import { formatRupees } from "@/lib/money";
import { cn } from "@/lib/utils";

import { correctInvoiceAction } from "../../actions";

export const metadata: Metadata = { title: "Correct the bill" };

/** 11.1, 11.3, 11.4 (decision 49): cancel and reissue an issued bill with a corrected reading or adjustment lines. */
export default async function CorrectBillPage({ params }: PageProps<"/owner/tickets/[id]/correct">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const view = await getCorrectionView(owner, id);
  if (!view) notFound();
  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <BackLink href={`/owner/tickets/${id}`} label="Ticket" />
        <PageHeader
          title="Correct the bill"
          description={`${view.ticket.customer_name} · ${view.ticket.machine_name} · ${view.invoice.invoiceNo}: ${formatRupees(view.invoice.totalCents)}${view.invoice.paidCents > 0 ? `, ${formatRupees(view.invoice.paidCents)} paid` : ""}`}
        />
        {view.disputed && <p className="-mt-3 text-sm text-muted-foreground">This answers the customer&apos;s dispute: it is resolved as &quot;Bill corrected&quot;.</p>}
      </div>
      {view.blocked ? (
        <div className="space-y-3">
          <p role="status" className="rounded-lg bg-muted px-3 py-2" data-testid="correction-blocked">
            {view.blocked}
          </p>
          <Link href={`/owner/tickets/${id}`} className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
            Back to the ticket
          </Link>
        </div>
      ) : (
        <CorrectionForm view={view} action={correctInvoiceAction} />
      )}
    </div>
  );
}
