import { ChevronRight, FileText, Printer, Receipt, Wallet, Wrench } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { requestTitle } from "@/components/service/service-display";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import type { CustomerDashboard } from "@/lib/reports/types";
import { type ServiceType, STATUS_LABEL, type ServiceStatus, type TonerColour } from "@/lib/service/states";
import { CUSTOMER_PAYMENT_STATUS_LABEL, INVOICE_STATUS_LABEL } from "@/lib/status-labels";

/**
 * CP-01: below "What you need to do now", the customer's account at a glance:
 * balance and credit, machines with the next billing date, the latest bill,
 * recent payments and open service requests. From one database call (RLS).
 */

function Section({ title, icon: Icon, href, linkLabel, children, testId }: { title: string; icon: typeof Wallet; href: string; linkLabel: string; children: ReactNode; testId: string }) {
  return (
    <section className="rounded-xl border bg-background" data-testid={testId}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
        <h2 className="flex-1 font-semibold">{title}</h2>
        <Link href={href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary">
          {linkLabel} <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function CustomerSummary({ d }: { d: CustomerDashboard }) {
  const bill = d.latest_invoice;
  return (
    <div className="space-y-3" aria-label="Your account">
      <Link href="/customer/bills" className="grid grid-cols-2 gap-2" data-testid="customer-balance">
        <div className="rounded-xl border bg-background p-4">
          <p className="text-xs text-muted-foreground">To pay</p>
          <p className="text-2xl font-bold tabular-nums" data-testid="customer-outstanding">
            {formatRupees(d.outstanding_cents)}
          </p>
        </div>
        <div className="rounded-xl border bg-background p-4">
          <p className="text-xs text-muted-foreground">Your credit</p>
          <p className="text-2xl font-bold tabular-nums">{formatRupees(d.credit_cents)}</p>
        </div>
      </Link>

      <Section title="Your machines" icon={Printer} href="/customer/machines" linkLabel="All" testId="customer-machines">
        {d.machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No machines rented.</p>
        ) : (
          <ul className="divide-y text-sm">
            {d.machines.map((m) => (
              <li key={m.agreement_id} className="py-2">
                <p className="font-medium">
                  {m.name} <span className="text-muted-foreground">({m.serial_no})</span>
                </p>
                <p className="text-muted-foreground">Next meter reading: {formatDate(m.next_cycle_date)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Latest bill" icon={FileText} href="/customer/bills" linkLabel="All bills" testId="customer-latest-bill">
        {!bill ? (
          <p className="text-sm text-muted-foreground">No bills yet.</p>
        ) : (
          <Link href={`/customer/bills/${bill.id}`} className="flex min-h-12 items-center justify-between gap-3 text-sm">
            <span>
              <span className="block font-medium">{bill.invoice_no}</span>
              <span className="text-muted-foreground">
                {INVOICE_STATUS_LABEL[bill.status] ?? bill.status}
                {bill.due_date ? ` · due ${formatDate(bill.due_date)}` : ""}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{formatRupees(bill.total_cents)}</span>
          </Link>
        )}
      </Section>

      <Section title="Recent payments" icon={Receipt} href="/customer/payments" linkLabel="All" testId="customer-payments">
        {d.recent_payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {d.recent_payments.map((p) => (
              <li key={p.id}>
                <Link href={`/customer/payments/${p.id}`} className="flex min-h-11 items-center justify-between gap-3">
                  <span>
                    <span className="block">{formatDate(p.paid_on)}</span>
                    <span className="text-xs text-muted-foreground">{CUSTOMER_PAYMENT_STATUS_LABEL[p.status] ?? p.status}</span>
                  </span>
                  <span className="font-semibold tabular-nums">{formatRupees(p.accepted_amount_cents ?? p.amount_cents)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Service requests" icon={Wrench} href="/customer/service" linkLabel="All" testId="customer-requests">
        {d.open_requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open requests.</p>
        ) : (
          <ul className="divide-y text-sm">
            {d.open_requests.map((r) => (
              <li key={r.id}>
                <Link href={`/customer/service/${r.id}`} className="flex min-h-11 items-center justify-between gap-3">
                  <span>
                    <span className="block font-medium">{requestTitle({ type: r.type as ServiceType, tonerColours: r.toner_colours as TonerColour[], partName: r.part_name })}</span>
                    <span className="text-xs text-muted-foreground">{r.machine}</span>
                  </span>
                  <span className="text-xs font-medium">{STATUS_LABEL[r.status as ServiceStatus] ?? r.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
