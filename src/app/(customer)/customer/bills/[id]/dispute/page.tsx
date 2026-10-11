import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DisputeForm } from "@/components/disputes/dispute-form";
import { BackLink } from "@/components/portal/back-link";
import { buttonVariants } from "@/components/ui/button";
import { uuidSchema } from "@/lib/accounts/schemas";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { getDisputeForm } from "@/lib/disputes/service";
import { formatRupees } from "@/lib/money";
import { cn } from "@/lib/utils";

import { raiseDisputeAction } from "../../actions";

export const metadata: Metadata = { title: "Dispute bill" };

/** 11.4 / CP-06: dispute an issued bill, with a reason and an optional photo or PDF. */
export default async function DisputeBillPage({ params }: PageProps<"/customer/bills/[id]/dispute">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const form = await getDisputeForm(user, id);
  if (!form) return deniedNotFound(user, "invoices", id, "/customer/bills/[id]/dispute");
  const inv = form.invoice;
  return (
    <div className="space-y-5">
      <div>
        <BackLink href={`/customer/bills/${inv.id}`} label={`Bill ${inv.invoice_no}`} />
        <h1 className="text-2xl font-bold tracking-tight">Dispute this bill</h1>
        <p className="text-muted-foreground">
          {inv.invoice_no} · {form.machine} · {formatRupees(inv.total_cents - inv.amount_paid_cents)} to pay
        </p>
      </div>
      {form.blocked ? (
        <div className="space-y-4">
          <p role="status" className="rounded-lg bg-muted px-3 py-2" data-testid="dispute-blocked">
            {form.blocked}
          </p>
          <Link href={`/customer/tickets/${form.ticketId}`} className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full text-base")}>
            Open the ticket and its messages
          </Link>
        </div>
      ) : (
        <DisputeForm invoiceId={inv.id} invoiceNo={inv.invoice_no ?? ""} ownerId={form.ownerId} customerId={user.id} action={raiseDisputeAction} />
      )}
      <p className="text-xs text-muted-foreground">The meter readings of this bill, who confirmed them and when are kept as the record, even after the meter photo was deleted.</p>
    </div>
  );
}
