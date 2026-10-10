import { ArrowLeftRight, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { settleDepositAction, updateTermsAction } from "@/app/(owner)/owner/agreements/actions";
import { Facts, TermsHistory, termsFacts } from "@/components/agreements/agreement-display";
import { SettleDepositForm, TermsEditForm } from "@/components/agreements/agreement-forms";
import { MachineTypeBadge } from "@/components/machines/machine-badges";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { billingDayText, cycleDate, effectiveCycleForChange, isEndingSoon, todayInColombo } from "@/lib/agreements/cycle-calendar";
import { getAgreement, getTermsHistory } from "@/lib/agreements/queries";
import type { LateFeeMode } from "@/lib/agreements/schemas";
import { versionForCycle } from "@/lib/agreements/terms";
import { requireUser } from "@/lib/auth/current-user";
import { getAdvances, getDepositState } from "@/lib/deposits/queries";
import { formatCount, formatDate, formatDateTime } from "@/lib/format";
import { centsToRupeesInput, formatRupees } from "@/lib/money";
import { getLateFeeSources } from "@/lib/settings/billing";
import { describeOwnerDefault } from "@/lib/settings/billing-schema";
import { DEPOSIT_KIND_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/status-labels";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Agreement" };

const STATUS_LABEL = { ACTIVE: "Active", SUSPENDED: "Suspended", TERMINATED: "Ended" } as const;
const CREDIT_STATUS_LABEL: Record<string, string> = { AVAILABLE: "not used yet", APPLIED: "used on invoices", REFUNDED: "refunded" };

/**
 * Agreement terms, the monthly billing day, edits from the next cycle, the full
 * history (AGR-01..03, LATE-01), and the money received upfront: deposit held,
 * its ledger, settle later; advance payments (DEP-01..04).
 */
export default async function AgreementPage({ params, searchParams }: PageProps<"/owner/agreements/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const agreement = await getAgreement(id);
  if (!agreement) notFound();
  const [history, deposit, advances, lateFee] = await Promise.all([
    getTermsHistory(id),
    getDepositState(await createClient(), id),
    getAdvances(id),
    getLateFeeSources(),
  ]);
  const { assigned } = await searchParams;
  const ownerDefault = describeOwnerDefault(lateFee);

  const today = todayInColombo();
  const live = agreement.status !== "TERMINATED";
  const dateOf = (n: number) => cycleDate(agreement.first_billing_date, n);
  const next = effectiveCycleForChange({ firstBillingDate: agreement.first_billing_date, nextCycleNo: agreement.next_cycle_no, today });
  // Terms of the next ticket to open, and the newest version (it may still be pending).
  const nextTicketTerms = versionForCycle(history, agreement.next_cycle_no);
  const latest = history[0];
  const pending = latest && nextTicketTerms && latest.version !== nextTicketTerms.version ? latest : null;
  const machine = agreement.machine;
  const deductibleCents = deposit.invoices.filter((i) => i.deductible).reduce((s, i) => s + i.balanceCents, 0);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href={`/owner/machines/${machine.id}`} label={`${machine.brand} ${machine.model}`} />
        <PageHeader title="Rental agreement" description={`${agreement.customer.name} · ${machine.brand} ${machine.model} (${machine.serial_no})`} />
        <div className="-mt-3 flex flex-wrap gap-2">
          <Badge variant={live ? "secondary" : "outline"}>{STATUS_LABEL[agreement.status]}</Badge>
          <MachineTypeBadge type={machine.type} />
          {live && isEndingSoon(agreement.end_date, today) && <Badge variant="destructive">Ending soon</Badge>}
          {!live && deposit.heldCents > 0 && <Badge variant="destructive">Deposit to settle</Badge>}
        </div>
      </div>

      {assigned && (
        <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-sm">
          Machine assigned. The first meter reading will be requested on {formatDate(agreement.first_billing_date)}.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Agreement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Facts
            items={[
              ["Customer", <Link key="c" href={`/owner/customers/${agreement.customer.id}`} className="text-primary hover:underline">{agreement.customer.name}</Link>],
              ["Installation location", agreement.installation_location ?? "—"],
              ["Start date", formatDate(agreement.start_date)],
              ["First billing date", <span key="f" data-testid="first-billing-date">{formatDate(agreement.first_billing_date)}</span>],
              ["Billing", billingDayText(agreement.first_billing_date)],
              ...(live
                ? ([["Next meter request", `${formatDate(agreement.next_cycle_date)} (cycle ${agreement.next_cycle_no})`]] as [string, string][])
                : []),
              ["End date", agreement.end_date ? formatDate(agreement.end_date) : "Open-ended"],
              [
                "Initial readings",
                `B&W ${formatCount(agreement.initial_bw_reading)}${agreement.initial_colour_reading !== null ? `, colour ${formatCount(agreement.initial_colour_reading)}` : ""}`,
              ],
              ...(!live
                ? ([
                    [
                      "Closing readings",
                      `B&W ${agreement.closing_bw_reading !== null ? formatCount(agreement.closing_bw_reading) : "—"}${agreement.closing_colour_reading !== null ? `, colour ${formatCount(agreement.closing_colour_reading)}` : ""}`,
                    ],
                    ["Returned", `${agreement.terminated_at ? formatDateTime(agreement.terminated_at) : "—"} · ${agreement.termination_reason ?? ""}`],
                  ] as [string, string][])
                : []),
            ]}
          />
          {live && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href={`/owner/machines/${machine.id}/return`} className={cn(buttonVariants({ variant: "outline" }), "h-12 gap-2 text-base")}>
                <Undo2 className="size-5" aria-hidden /> Return machine
              </Link>
              <Link href={`/owner/machines/${machine.id}/reassign`} className={cn(buttonVariants({ variant: "outline" }), "h-12 gap-2 text-base")}>
                <ArrowLeftRight className="size-5" aria-hidden /> Reassign
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deposit and advance payments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-base">
            Deposit held: <strong data-testid="agreement-deposit-held">{formatRupees(deposit.heldCents)}</strong>
          </p>
          {deposit.transactions.length > 0 && (
            <ul className="divide-y text-sm" aria-label="Deposit history">
              {deposit.transactions.map((t) => (
                <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {DEPOSIT_KIND_LABEL[t.kind]} · {formatDate(t.occurred_on)}
                    {t.method && t.kind !== "DEDUCTED" ? ` · ${PAYMENT_METHOD_LABEL[t.method]}` : ""}
                    {t.reference ? ` · ${t.reference}` : ""}
                    {t.note ? ` · ${t.note}` : ""}
                  </span>
                  <span className="tabular-nums">
                    {t.kind === "RECEIVED" ? "" : "−"}
                    {formatRupees(t.amount_cents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!live && deposit.heldCents > 0 && (
            <div className="space-y-3 rounded-xl border p-3">
              <h3 className="font-semibold">Settle deposit</h3>
              <p className="text-sm text-muted-foreground">
                Unpaid bills on this agreement: {formatRupees(deposit.invoices.reduce((s, i) => s + i.balanceCents, 0))}
                {deductibleCents !== deposit.invoices.reduce((s, i) => s + i.balanceCents, 0) && ` (${formatRupees(deductibleCents)} can be paid from the deposit)`}.
              </p>
              <SettleDepositForm heldCents={deposit.heldCents} deductibleCents={deductibleCents} today={today} action={settleDepositAction.bind(null, id)} />
            </div>
          )}
          {advances.length > 0 ? (
            <ul className="divide-y text-sm" aria-label="Advance payments">
              {advances.map((c) => (
                <li key={c.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    Advance payment · {c.received_on ? formatDate(c.received_on) : formatDate(c.created_at.slice(0, 10))}
                    {c.method ? ` · ${PAYMENT_METHOD_LABEL[c.method]}` : ""}
                    {c.reference ? ` · ${c.reference}` : ""} · {CREDIT_STATUS_LABEL[c.status]}
                  </span>
                  <span className="tabular-nums">{formatRupees(c.amount_cents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No advance payment. Advances are taken off the next invoices automatically.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current terms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Facts items={termsFacts(nextTicketTerms ?? agreement, ownerDefault)} />
          {pending && (
            <p className="rounded-lg bg-primary/5 px-3 py-2 text-sm" data-testid="pending-terms">
              New terms (version {pending.version}) apply <strong>from the next cycle</strong>: cycle {pending.effective_from_cycle_no}, due{" "}
              {formatDate(dateOf(pending.effective_from_cycle_no))}.
            </p>
          )}
        </CardContent>
      </Card>

      {live && latest && (
        <Card>
          <CardHeader>
            <CardTitle>Edit terms</CardTitle>
          </CardHeader>
          <CardContent>
            <TermsEditForm
              type={machine.type}
              nextCycle={next}
              location={agreement.installation_location ?? ""}
              endDate={agreement.end_date}
              ownerLateFee={ownerDefault}
              defaults={{
                monthly_commitment: centsToRupeesInput(latest.monthly_commitment_cents),
                bw_included: String(latest.bw_included),
                bw_rate: centsToRupeesInput(latest.bw_rate_cents),
                colour_included: latest.colour_included?.toString() ?? "",
                colour_rate: latest.colour_rate_cents !== null ? centsToRupeesInput(latest.colour_rate_cents) : "",
                due_days: String(latest.due_days),
                late_fee_mode: latest.late_fee_mode as LateFeeMode,
                late_fee: latest.late_fee_cents !== null ? centsToRupeesInput(latest.late_fee_cents) : "",
              }}
              action={updateTermsAction.bind(null, id)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Terms history</CardTitle>
        </CardHeader>
        <CardContent>
          <TermsHistory history={history} nextCycleNo={agreement.next_cycle_no} cycleDateOf={dateOf} />
        </CardContent>
      </Card>
    </div>
  );
}
