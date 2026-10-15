import { ArrowDownRight, ArrowUpRight, CalendarClock, ChevronRight, ClipboardCheck, Printer, Star, Ticket, TrendingUp, Wallet, Wrench } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { requestTitle } from "@/components/service/service-display";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { changePercent } from "@/lib/reports/maths";
import type { OwnerDashboard } from "@/lib/reports/types";
import { SERVICE_TYPES, type ServiceType, type TonerColour, TYPE_LABEL, URGENCIES, URGENCY_LABEL } from "@/lib/service/states";
import { TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/**
 * RPT-01 / spec 10.1: the owner's Home cards from one database call. Every card
 * taps through to the matching list. `links` builds the hrefs, so the admin's
 * support view (decision 81) shows the same cards with read-only destinations.
 */

export interface DashboardLinks {
  income: string;
  outstanding: string;
  approvals: string;
  payments: string;
  payment: (id: string) => string;
  tickets: (status?: string) => string;
  service: (urgency?: string) => string;
  serviceItem: (id: string) => string;
  machines: (status?: string) => string;
  machineReport: string;
  rental: string;
  ratings: string;
}

export const OWNER_LINKS: DashboardLinks = {
  income: "/owner/reports/income?range=this_month",
  outstanding: "/owner/outstanding",
  approvals: "/owner/approvals",
  payments: "/owner/payments?status=TO_VERIFY",
  payment: (id) => `/owner/payments/${id}`,
  tickets: (status) => `/owner/tickets${status ? `?status=${status}` : ""}`,
  service: (urgency) => `/owner/service${urgency ? `?urgency=${urgency}` : ""}`,
  serviceItem: (id) => `/owner/service/${id}`,
  machines: (status) => `/owner/machines${status ? `?status=${status}` : ""}`,
  machineReport: "/owner/reports/machines",
  rental: "/owner/reports/rental",
  ratings: "/owner/service?status=CLOSED",
};

/** Placeholder while the cards stream in (same grid, so nothing jumps). */
export function DashboardSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Loading your dashboard" data-testid="dashboard-loading">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="h-36 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}

const STAGE_ORDER =["METER_REQUESTED", "PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED", "REOPENED"];

function CardLink({ href, children, testId, className }: { href: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <Link href={href} className={cn("group block rounded-xl focus-visible:outline-2 focus-visible:outline-primary", className)} data-testid={testId}>
      {children}
    </Link>
  );
}

function Tile({ title, icon: Icon, children, alert }: { title: string; icon: typeof Wallet; children: ReactNode; alert?: boolean }) {
  return (
    <Card className={cn("h-full transition-colors group-hover:bg-muted/40", alert && "ring-destructive/40")}>
      <CardHeader className="flex flex-row items-center gap-2">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
        <CardTitle className="flex-1">{title}</CardTitle>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

function Change({ current, previous, label }: { current: number; previous: number; label: string }) {
  const pct = changePercent(current, previous);
  if (pct === null) return <p className="text-xs text-muted-foreground">Nothing to compare with {label}.</p>;
  const Icon = pct >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className={cn("size-4", pct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")} aria-hidden />
      <span>
        {pct >= 0 ? "Up" : "Down"} {Math.abs(pct)}% on {label} ({formatRupees(previous)})
      </span>
    </p>
  );
}

const requestLabel = (r: OwnerDashboard["service"]["top"][number]) =>
  requestTitle({ type: r.type as ServiceType, tonerColours: r.toner_colours as TonerColour[], partName: r.part_name });

export function OwnerDashboardCards({ d, links, depositsList }: { d: OwnerDashboard; links: DashboardLinks; depositsList?: ReactNode }) {
  const toReview = d.readings_to_review + d.slips_to_verify;
  const priority = (d.service.by_urgency.URGENT ?? 0) + (d.service.by_urgency.HIGH ?? 0);
  const openTickets = Object.values(d.tickets_by_status).reduce((a, b) => a + b, 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="owner-dashboard">
      <CardLink href={links.income} testId="card-income">
        <Tile title="Income this month" icon={TrendingUp}>
          <p className="text-3xl font-bold tabular-nums" data-testid="income-this-month">
            {formatRupees(d.collected_this_month)}
          </p>
          <p className="text-sm text-muted-foreground">collected · {formatRupees(d.invoiced_this_month)} billed</p>
          <Change current={d.collected_this_month} previous={d.collected_last_month_to_date} label="the same day last month" />
          <p className="text-xs text-muted-foreground">Last month in full: {formatRupees(d.collected_last_month)} collected</p>
        </Tile>
      </CardLink>

      <CardLink href={links.outstanding} testId="card-outstanding">
        <Tile title="Outstanding" icon={Wallet} alert={d.overdue_cents > 0}>
          <p className="text-3xl font-bold tabular-nums" data-testid="home-outstanding">
            {formatRupees(d.outstanding_cents)}
          </p>
          {d.overdue_cents > 0 ? (
            <p className="text-sm font-medium text-destructive">
              {formatRupees(d.overdue_cents)} overdue ({d.overdue_bills} {d.overdue_bills === 1 ? "bill" : "bills"})
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing overdue.</p>
          )}
        </Tile>
      </CardLink>

      <Card className={cn(toReview > 0 && "ring-primary/50")} data-testid="card-review">
        <CardHeader className="flex flex-row items-center gap-2">
          <ClipboardCheck className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>To review</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2">
          <Link href={links.approvals} className="rounded-lg bg-muted/60 p-3 hover:bg-muted" data-testid="home-approvals">
            <span className="block text-2xl font-bold tabular-nums">{d.readings_to_review}</span>
            <span className="text-xs text-muted-foreground">meter {d.readings_to_review === 1 ? "reading" : "readings"}</span>
          </Link>
          <Link href={links.payments} className="rounded-lg bg-muted/60 p-3 hover:bg-muted" data-testid="home-payments">
            <span className="block text-2xl font-bold tabular-nums">{d.slips_to_verify}</span>
            <span className="text-xs text-muted-foreground">payment {d.slips_to_verify === 1 ? "slip" : "slips"}</span>
          </Link>
        </CardContent>
      </Card>

      <Card data-testid="card-tickets">
        <CardHeader className="flex flex-row items-center gap-2">
          <Ticket className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle className="flex-1">Billing tickets</CardTitle>
          <Link href={links.tickets()} className="text-sm font-medium text-primary">
            {openTickets} open
          </Link>
        </CardHeader>
        <CardContent>
          {openTickets === 0 ? (
            <p className="text-sm text-muted-foreground">No open tickets.</p>
          ) : (
            <ul className="divide-y text-sm">
              {STAGE_ORDER.filter((s) => d.tickets_by_status[s]).map((s) => (
                <li key={s}>
                  <Link href={links.tickets(s)} className="flex min-h-11 items-center justify-between gap-2">
                    <span className={cn(s === "OVERDUE" && "font-medium text-destructive")}>{TICKET_STATUS_LABEL[s] ?? s}</span>
                    <span className="font-semibold tabular-nums">{d.tickets_by_status[s]}</span>
                  </Link>
                </li>
              ))}
              {d.tickets_escalated > 0 && (
                <li>
                  <Link href={links.tickets("ESCALATED")} className="flex min-h-11 items-center justify-between gap-2 font-medium text-destructive">
                    <span>Late stage (escalated)</span>
                    <span className="tabular-nums">{d.tickets_escalated}</span>
                  </Link>
                </li>
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className={cn("sm:col-span-2", priority > 0 && "ring-destructive/40")} data-testid="home-service">
        <CardHeader className="flex flex-row items-center gap-2">
          <Wrench className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle className="flex-1">Open service requests</CardTitle>
          <Link href={links.service()} className="text-sm font-medium text-primary">
            {d.service.total} open
          </Link>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.service.total === 0 ? (
            <p className="text-sm text-muted-foreground">No open requests.</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {[...URGENCIES].reverse().map((u) => (
                  <Link key={u} href={links.service(u)} className="rounded-lg bg-muted/60 p-2 text-center hover:bg-muted">
                    <span className={cn("block text-xl font-bold tabular-nums", (u === "URGENT" || u === "HIGH") && (d.service.by_urgency[u] ?? 0) > 0 && "text-destructive")}>
                      {d.service.by_urgency[u] ?? 0}
                    </span>
                    <span className="text-xs text-muted-foreground">{URGENCY_LABEL[u]}</span>
                  </Link>
                ))}
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {SERVICE_TYPES.filter((t) => d.service.by_type[t]).map((t) => (
                  <span key={t}>
                    {TYPE_LABEL[t]}: {d.service.by_type[t]}
                  </span>
                ))}
                {priority > 0 && <span className="font-medium text-destructive">{priority} urgent or high</span>}
                {d.service.overdue > 0 && <span className="font-medium text-destructive">{d.service.overdue} not acknowledged in time</span>}
                {d.service.to_confirm > 0 && <span>{d.service.to_confirm} waiting for the customer</span>}
              </p>
              <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Top service requests">
                {d.service.top.map((r) => (
                  <li key={r.id}>
                    <Link href={links.serviceItem(r.id)} className="flex min-h-12 flex-wrap items-center gap-x-2 px-3 py-2 text-sm">
                      <span className={cn("font-medium", (r.urgency === "URGENT" || r.urgency === "HIGH") && "text-destructive")}>
                        {URGENCY_LABEL[r.urgency as keyof typeof URGENCY_LABEL] ?? r.urgency}
                      </span>
                      <span className="font-medium">{requestLabel(r)}</span>
                      <span className="text-muted-foreground">{r.customer}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-machines">
        <CardHeader className="flex flex-row items-center gap-2">
          <Printer className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle className="flex-1">Machines</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {(
            [
              ["RENTED", "Rented"],
              ["AVAILABLE", "Available"],
              ["UNDER_REPAIR", "Under repair"],
            ] as const
          ).map(([s, label]) => (
            <Link key={s} href={links.machines(s)} className="rounded-lg bg-muted/60 p-2 text-center hover:bg-muted" data-testid={`machines-${s}`}>
              <span className="block text-xl font-bold tabular-nums">{d.machines[s] ?? 0}</span>
              <span className="text-xs text-muted-foreground">{label}</span>
            </Link>
          ))}
          {d.machines_in_service > 0 && <p className="col-span-3 text-xs text-muted-foreground">{d.machines_in_service} rented with service in progress.</p>}
        </CardContent>
      </Card>

      <CardLink href={links.ratings} testId="card-rating">
        <Tile title="Service rating" icon={Star}>
          <p className="text-3xl font-bold tabular-nums">{d.rating.average === null ? "—" : `${Number(d.rating.average).toFixed(1)} / 5`}</p>
          <p className="text-sm text-muted-foreground">{d.rating.count === 0 ? "No ratings yet." : `from ${d.rating.count} ${d.rating.count === 1 ? "rating" : "ratings"}`}</p>
        </Tile>
      </CardLink>

      <Card data-testid="card-deposits">
        <CardHeader>
          <CardTitle>Deposits to settle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {d.deposits.count === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to settle.</p>
          ) : (
            <>
              <p className="text-sm">
                <span className="font-semibold">{formatRupees(d.deposits.held_cents)}</span> held on {d.deposits.count} returned{" "}
                {d.deposits.count === 1 ? "machine" : "machines"}.
              </p>
              {depositsList}
            </>
          )}
        </CardContent>
      </Card>

      <CardLink href={links.rental} testId="card-ending">
        <Tile title="Agreements ending soon" icon={CalendarClock} alert={d.ending_soon > 0}>
          <p className="text-3xl font-bold tabular-nums">{d.ending_soon}</p>
          <p className="text-sm text-muted-foreground">within your notice period</p>
        </Tile>
      </CardLink>

      <Card data-testid="card-top-machines">
        <CardHeader className="flex flex-row items-center gap-2">
          <CardTitle className="flex-1">Top machines</CardTitle>
          <Link href={links.machineReport} className="text-sm font-medium text-primary">
            Report
          </Link>
        </CardHeader>
        <CardContent>
          {d.top_machines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bills in the last three months.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {d.top_machines.map((m) => (
                <li key={m.id} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="shrink-0 font-medium tabular-nums">{formatRupees(m.revenue_cents)}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Billed this month and the two before.</p>
        </CardContent>
      </Card>

      <Card data-testid="card-recent-payments">
        <CardHeader>
          <CardTitle>Recent payments</CardTitle>
        </CardHeader>
        <CardContent>
          {d.recent_payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {d.recent_payments.map((p) => (
                <li key={p.id}>
                  <Link href={links.payment(p.id)} className="flex min-h-11 items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.customer}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(p.paid_on)}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{formatRupees(p.amount_cents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
