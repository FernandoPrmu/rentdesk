import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { InvoiceDetailView } from "@/components/invoices/invoice-views";
import { PaymentList } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { buttonVariants } from "@/components/ui/button";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail } from "@/lib/invoices/queries";
import { listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Bill" };

/** CP-04 / CP-05, PAY-08: one bill with its lines, status, due date, the PDF and its payments (RLS: own issued invoices). */
export default async function CustomerBillPage({ params }: PageProps<"/customer/bills/[id]">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) return z.uuid().safeParse(id).success ? deniedNotFound(user, "invoices", id, "/customer/bills/[id]") : notFound();
  const supabase = await createClient();
  const [payments, disputes] = await Promise.all([
    listPayments(supabase, { invoiceId: invoice.id }),
    supabase.from("disputes").select("id", { count: "exact", head: true }).eq("invoice_id", invoice.id),
  ]);
  const payable = ["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"].includes(invoice.status) && invoice.total_cents > invoice.amount_paid_cents;
  // 11.4 / decision 47: an issued bill can be disputed once while it is unpaid and no slip waits.
  const disputable = payable && (disputes.count ?? 0) === 0;
  return (
    <div className="space-y-4">
      <BackLink href="/customer/bills" label="Bills" />
      <InvoiceDetailView invoice={invoice} hrefBase="/customer/bills" />
      {invoice.status === "DISPUTED" && (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          You disputed this bill. Your rental company is looking at it; reminders stop until they answer.{" "}
          <Link href={`/customer/tickets/${invoice.ticket_id}`} className="font-medium underline underline-offset-4">
            Open the ticket
          </Link>
        </p>
      )}
      {payable && (
        <Link href={`/customer/pay?invoice=${invoice.id}`} className={cn(buttonVariants(), "h-12 w-full text-base")} data-testid="pay-this-bill">
          Pay this bill
        </Link>
      )}
      {disputable && (
        <Link href={`/customer/bills/${invoice.id}/dispute`} className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full text-base")} data-testid="dispute-this-bill">
          Dispute this bill
        </Link>
      )}
      {payments.length > 0 && (
        <section className="space-y-2" aria-labelledby="bill-payments">
          <h2 id="bill-payments" className="text-lg font-semibold">Payments</h2>
          <PaymentList payments={payments} hrefBase="/customer/payments" audience="CUSTOMER" empty="" />
        </section>
      )}
    </div>
  );
}
