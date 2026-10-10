import { ChevronRight, Download, FileClock, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatInvoiceMoney } from "@/lib/invoices/pdf/format";
import { duplicateText } from "@/lib/payments/duplicates";
import { activeAllocations, type PaymentRow } from "@/lib/payments/service";
import { CUSTOMER_PAYMENT_STATUS_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/**
 * Payment lists, badges, receipt downloads and the money tabs (PAY-08, CP-05).
 * Amounts as on the PDFs ("Rs. 12,800.00"). Receipts download through
 * /api/receipts/{id}/pdf (signed URL, RLS), in a new tab.
 */

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SUBMITTED: "default",
  ACCEPTED: "secondary",
  PARTIAL: "secondary",
  REJECTED: "destructive",
  REVERSED: "destructive",
};

export function PaymentStatusBadge({ status, audience = "OWNER" }: { status: string; audience?: "OWNER" | "CUSTOMER" }) {
  const label = (audience === "CUSTOMER" ? CUSTOMER_PAYMENT_STATUS_LABEL : PAYMENT_STATUS_LABEL)[status] ?? status;
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"} data-testid="payment-status">
      {label}
    </Badge>
  );
}

export const paymentAmount = (p: Pick<PaymentRow, "status" | "amount_cents" | "accepted_amount_cents">) =>
  p.status === "ACCEPTED" || p.status === "PARTIAL" || p.status === "REVERSED" ? (p.accepted_amount_cents ?? p.amount_cents) : p.amount_cents;

export const billNumbers = (p: Pick<PaymentRow, "allocations" | "status">) => {
  const rows = activeAllocations(p).filter((a) => (p.status === "ACCEPTED" || p.status === "PARTIAL" || p.status === "REVERSED" ? a.applied_cents > 0 : true));
  return rows.map((a) => a.invoice.invoice_no ?? "").filter(Boolean);
};

export function PaymentList({
  payments,
  hrefBase,
  empty,
  audience,
}: {
  payments: PaymentRow[];
  /** Null: rows without a link (admin, read-only). */
  hrefBase: string | null;
  empty: string;
  audience: "OWNER" | "CUSTOMER";
}) {
  if (payments.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-background" aria-label="Payments">
      {payments.map((p) => {
        const bills = billNumbers(p);
        const Row = ({ children }: { children: React.ReactNode }) =>
          hrefBase ? (
            <Link href={`${hrefBase}/${p.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60" data-testid="payment-row">
              {children}
            </Link>
          ) : (
            <div className="flex min-h-16 items-center gap-3 px-4 py-3" data-testid="payment-row">
              {children}
            </div>
          );
        return (
          <li key={p.id}>
            <Row>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold tabular-nums">{formatInvoiceMoney(paymentAmount(p))}</span>
                  <PaymentStatusBadge status={p.status} audience={audience} />
                  {audience === "OWNER" && p.duplicate_of_payment_id && (
                    <Badge variant="destructive" data-testid="duplicate-flag">
                      <TriangleAlert aria-hidden /> Possible duplicate
                    </Badge>
                  )}
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {[audience === "OWNER" ? p.customer.name : null, bills.length > 0 ? bills.join(", ") : "Credit", PAYMENT_METHOD_LABEL[p.method] ?? p.method]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p>Paid {formatDate(p.paid_on)}</p>
                {p.receipts[0] && <p>{p.receipts[0].receipt_no}</p>}
              </div>
              {hrefBase && <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

/** "Download receipt", or "being prepared" while its PDF is made. */
export function ReceiptButton({ receipt, compact }: { receipt: { id: string; receipt_no: string; pdf_path: string | null; pdf_status: string } | undefined; compact?: boolean }) {
  if (!receipt) return null;
  if (!receipt.pdf_path) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="receipt-pending">
        <FileClock className="size-5 shrink-0" aria-hidden />
        Receipt {receipt.receipt_no} is being prepared. Please check again in a few minutes.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <a
        href={`/api/receipts/${receipt.id}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium",
          compact ? "h-11 border px-3 text-sm hover:bg-muted" : "h-12 w-full bg-primary px-5 text-base text-primary-foreground hover:bg-primary/90 sm:w-auto",
        )}
        data-testid="download-receipt"
      >
        <Download className="size-5" aria-hidden /> Receipt {receipt.receipt_no}
      </a>
      {receipt.pdf_status === "PENDING" && <p className="text-xs text-muted-foreground">An updated receipt is being prepared.</p>}
    </div>
  );
}

/** Tabs between pages of one area (Bills · Payments; Invoices · Payments · Outstanding). */
export function SectionTabs({ tabs, label }: { tabs: { href: string; label: string; active: boolean; count?: number }[]; label: string }) {
  return (
    <nav aria-label={label} className="mb-4 flex gap-1 overflow-x-auto rounded-xl border bg-muted/50 p-1">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cn(
            "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap",
            t.active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function OwnerMoneyTabs({ active, toVerify }: { active: "invoices" | "payments" | "outstanding"; toVerify?: number }) {
  return (
    <SectionTabs
      label="Money"
      tabs={[
        { href: "/owner/invoices", label: "Invoices", active: active === "invoices" },
        { href: "/owner/payments", label: "Payments", active: active === "payments", count: toVerify },
        { href: "/owner/outstanding", label: "Outstanding", active: active === "outstanding" },
      ]}
    />
  );
}

export function CustomerMoneyTabs({ active }: { active: "bills" | "payments" }) {
  return (
    <SectionTabs
      label="Bills and payments"
      tabs={[
        { href: "/customer/bills", label: "Bills", active: active === "bills" },
        { href: "/customer/payments", label: "Payments", active: active === "payments" },
      ]}
    />
  );
}

/** The payment's bills: what it paid on each and what was left right after. */
export function AllocationList({ payment, hrefBase }: { payment: PaymentRow; hrefBase: string }) {
  const accepted = payment.status === "ACCEPTED" || payment.status === "PARTIAL" || payment.status === "REVERSED";
  const rows = activeAllocations(payment).filter((a) => !accepted || a.applied_cents > 0);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No bill: the whole amount is kept as credit.</p>;
  return (
    <ul className="divide-y" aria-label="Bills in this payment">
      {rows.map((a) => (
        <li key={a.invoice_id} className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="allocation">
          <Link href={`${hrefBase}/${a.invoice_id}`} className="font-medium text-primary underline-offset-4 hover:underline">
            {a.invoice.invoice_no}
          </Link>
          <span className="text-right tabular-nums">
            {accepted ? `${formatInvoiceMoney(a.applied_cents)} paid` : `${formatInvoiceMoney(a.planned_cents)} for this bill`}
            {accepted && a.balance_after_cents !== null && (
              <span className="block text-xs text-muted-foreground">{a.balance_after_cents > 0 ? `${formatInvoiceMoney(a.balance_after_cents)} left to pay` : "Paid in full"}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DuplicateNotice({ reasons, earlier }: { reasons: string[]; earlier: { submitted_at: string; status: string; amount_cents: number; reference: string | null; customer: string } | null }) {
  return (
    <div role="status" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="duplicate-notice">
      <p className="font-semibold text-destructive">{duplicateText(reasons)}</p>
      {earlier && (
        <p className="mt-1">
          Earlier payment: {formatInvoiceMoney(earlier.amount_cents)} from {earlier.customer}, sent {formatDateTime(earlier.submitted_at)}
          {earlier.reference ? `, reference ${earlier.reference}` : ""} ({PAYMENT_STATUS_LABEL[earlier.status] ?? earlier.status}).
        </p>
      )}
      <p className="mt-1 text-muted-foreground">Check it against your bank statement before accepting.</p>
    </div>
  );
}
