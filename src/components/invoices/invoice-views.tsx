import { ChevronRight, Download, FileClock } from "lucide-react";
import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import type { InvoiceDetail, InvoiceFilter, InvoiceRow } from "@/lib/invoices/queries";
import { LISTED_STATUSES } from "@/lib/invoices/queries";
import { formatInvoiceMoney } from "@/lib/invoices/pdf/format";
import { INVOICE_STATUS_LABEL } from "@/lib/status-labels";

/**
 * Invoice lists and details for the three portals (CP-04, CP-05; INV-09).
 * Amounts as on the PDF ("Rs. 12,800.00"). Downloads go through
 * /api/invoices/{id}/pdf (signed URL, RLS), in a new tab.
 */

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  AWAITING_PAYMENT: "default",
  PAYMENT_SUBMITTED: "secondary",
  PARTIALLY_PAID: "secondary",
  OVERDUE: "destructive",
  DISPUTED: "destructive",
  PAID: "outline",
  CANCELLED: "outline",
};

export function InvoiceStatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{INVOICE_STATUS_LABEL[status] ?? status}</Badge>;
}

const toPay = (i: { total_cents: number; amount_paid_cents: number }) => i.total_cents - i.amount_paid_cents;
const isOpen = (status: string) => !["PAID", "CANCELLED"].includes(status);

export function InvoiceList({
  invoices,
  hrefBase,
  empty,
  showCustomer,
}: {
  invoices: InvoiceRow[];
  hrefBase: string;
  empty: string;
  showCustomer?: boolean;
}) {
  if (invoices.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-background" aria-label="Invoices">
      {invoices.map((i) => (
        <li key={i.id}>
          <Link href={`${hrefBase}/${i.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60" data-testid="invoice-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{i.invoice_no}</span>
                <InvoiceStatusBadge status={i.status} />
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {[showCustomer ? i.customer.name : null, `${i.machine.brand} ${i.machine.model}`, i.due_date && isOpen(i.status) ? `due ${formatDate(i.due_date)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-semibold tabular-nums">{formatInvoiceMoney(isOpen(i.status) ? toPay(i) : i.total_cents)}</p>
              {i.issued_at && <p className="text-xs text-muted-foreground">{formatDate(i.issued_at.slice(0, 10))}</p>}
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Owner / admin list filters: a plain GET form keyed by the URL filters. */
export function InvoiceFilters({ filter, customers }: { filter: InvoiceFilter; customers?: { id: string; name: string }[] }) {
  return (
    <form key={JSON.stringify(filter)} method="get" role="search" className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <ChoiceSelect
        name="status"
        ariaLabel="Status"
        defaultValue={filter.status}
        emptyLabel="All statuses"
        options={LISTED_STATUSES.map((s) => ({ value: s, label: INVOICE_STATUS_LABEL[s] ?? s }))}
      />
      {customers && (
        <ChoiceSelect
          name="customer"
          ariaLabel="Customer"
          defaultValue={filter.customer}
          emptyLabel="All customers"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
      )}
      <label className="grid gap-1 text-xs text-muted-foreground">
        Issued from
        <Input type="date" name="from" defaultValue={filter.from} className="h-12 text-base text-foreground" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        Issued to
        <Input type="date" name="to" defaultValue={filter.to} className="h-12 text-base text-foreground" />
      </label>
      <Button type="submit" variant="secondary" className="h-12 self-end px-5 text-base">
        Filter
      </Button>
    </form>
  );
}

/** "Download PDF", or "being prepared" while the PDF is pending (INV-09). */
export function InvoicePdfButton({ invoice }: { invoice: Pick<InvoiceDetail, "id" | "pdf_path" | "pdf_status"> }) {
  if (!invoice.pdf_path) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="pdf-pending">
        <FileClock className="size-5 shrink-0" aria-hidden />
        Invoice PDF is being prepared. Please check again in a few minutes.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <a
        href={`/api/invoices/${invoice.id}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 text-base font-medium text-primary-foreground hover:bg-primary/90 sm:w-auto"
        data-testid="download-pdf"
      >
        <Download className="size-5" aria-hidden /> Download PDF
      </a>
      {invoice.pdf_status === "PENDING" && <p className="text-xs text-muted-foreground">An updated PDF is being prepared.</p>}
    </div>
  );
}

const KIND_LABEL = (i: InvoiceDetail) => (i.type === "ESTIMATED" ? "Estimated" : i.final ? "Final invoice" : null);

export function InvoiceDetailView({ invoice, showCustomer }: { invoice: InvoiceDetail; showCustomer?: boolean }) {
  const kind = KIND_LABEL(invoice);
  const open = isOpen(invoice.status);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{invoice.invoice_no}</h1>
            <InvoiceStatusBadge status={invoice.status} />
            {kind && <Badge variant="outline">{kind}</Badge>}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{open ? "To pay" : "Total"}</p>
            <p className="text-3xl font-bold tabular-nums" data-testid="invoice-amount">
              {formatInvoiceMoney(open ? toPay(invoice) : invoice.total_cents)}
            </p>
            {open && invoice.amount_paid_cents > 0 && (
              <p className="text-sm text-muted-foreground">
                {formatInvoiceMoney(invoice.amount_paid_cents)} of {formatInvoiceMoney(invoice.total_cents)} paid
              </p>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {showCustomer && (
              <>
                <dt className="text-muted-foreground">Customer</dt>
                <dd>{invoice.customer.name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Due date</dt>
            <dd className="font-medium" data-testid="invoice-due">{invoice.due_date ? formatDate(invoice.due_date) : "On receipt"}</dd>
            <dt className="text-muted-foreground">Issued</dt>
            <dd>{invoice.issued_at ? formatDate(invoice.issued_at.slice(0, 10)) : "—"}</dd>
            <dt className="text-muted-foreground">Period</dt>
            <dd>
              {formatDate(invoice.period_start)} – {formatDate(invoice.period_end)}
              {invoice.cycles_covered > 1 ? ` (${invoice.cycles_covered} months)` : ""}
            </dd>
            <dt className="text-muted-foreground">Machine</dt>
            <dd>
              {invoice.machine.brand} {invoice.machine.model} · {invoice.machine.serial_no}
            </dd>
          </dl>
          {invoice.status === "CANCELLED" && (
            <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              Cancelled{invoice.cancel_reason ? `: ${invoice.cancel_reason}` : ""}. Do not pay this invoice.
            </p>
          )}
          <InvoicePdfButton invoice={invoice} />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-lg font-semibold">Charges</h2>
          <ul className="divide-y" aria-label="Invoice lines">
            {invoice.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm" data-testid="invoice-line">
                <span>
                  {l.description}
                  {(l.line_type === "BW_EXCESS" || l.line_type === "COLOUR_EXCESS") && (
                    <span className="block text-xs text-muted-foreground">
                      {formatCount(l.quantity)} × {formatInvoiceMoney(l.rate_cents)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">{formatInvoiceMoney(l.amount_cents)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 py-2 font-semibold">
              <span>Total</span>
              <span className="tabular-nums" data-testid="invoice-total">{formatInvoiceMoney(invoice.total_cents)}</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  ISSUED: "Issued",
  LATE_FEE: "Late fee added",
  DUE_DATE: "Due date changed",
  CANCELLED: "Cancelled",
  CHANGED: "Amounts changed",
};

/** Owner / admin: every PDF made for the invoice (decision 34). */
export function PdfVersionHistory({
  invoiceId,
  versions,
}: {
  invoiceId: string;
  versions: { version: number; reason: string; template: string; byte_size: number; created_at: string }[];
}) {
  return (
    <Card>
      <CardContent>
        <h2 className="mb-2 text-lg font-semibold">PDF versions</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No PDF yet.</p>
        ) : (
          <ul className="divide-y" aria-label="PDF versions">
            {versions.map((v) => (
              <li key={v.version} className="flex items-center gap-3 py-2" data-testid="pdf-version">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    Version {v.version} · {REASON_LABEL[v.reason] ?? v.reason}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(v.created_at)} · {v.template === "LETTERHEAD" ? "Letterhead" : "Built-in design"} · {Math.max(1, Math.round(v.byte_size / 1024))} KB
                  </p>
                </div>
                <a
                  href={`/api/invoices/${invoiceId}/pdf?v=${v.version}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted"
                  aria-label={`Download version ${v.version}`}
                >
                  <Download className="size-4" aria-hidden /> PDF
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
