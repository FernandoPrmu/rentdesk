import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { addCommentAction, editCommentAction } from "@/app/actions/comments";
import { CommentThread } from "@/components/comments/comment-thread";
import { DisputeCard } from "@/components/disputes/dispute-card";
import { OwnerDisputeActions } from "@/components/disputes/owner-dispute-actions";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { dueText, TicketFlagBadges, TicketStatusBadge } from "@/components/tickets/ticket-display";
import { OwnerTicketActions } from "@/components/tickets/owner-ticket-actions";
import { TicketTimeline } from "@/components/tickets/ticket-timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { listComments } from "@/lib/comments/service";
import { getReadingRecord, getTicketDispute } from "@/lib/disputes/service";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { INVOICE_STATUS_LABEL } from "@/lib/status-labels";
import { waitingPaymentId } from "@/lib/tickets/owner-actions";
import { createClient } from "@/lib/supabase/server";
import { getTicket } from "@/lib/tickets/queries";
import { canPerform, isMeterStage } from "@/lib/tickets/states";
import { currentDue, nextStep } from "@/lib/tickets/view";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { disputeAction, ticketAction } from "../actions";

export const metadata: Metadata = { title: "Ticket" };

/**
 * TKT-06, TKT-10, TKT-11: the current stage, who must act, the due date, the owner's
 * actions, the dispute and its answers (11.4), correcting the bill (decision 49),
 * the messages with the customer and the full history.
 */
export default async function OwnerTicketPage({ params }: PageProps<"/owner/tickets/[id]">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const ticket = await getTicket(id);
  if (!ticket) return deniedNotFound(owner, "billing_cycle_tickets", id, "/owner/tickets/[id]");
  const now = new Date();
  const step = nextStep(ticket);
  const inv = ticket.invoice;
  const supabase = await createClient();
  const [waiting, dispute, comments, company] = await Promise.all([
    ticket.status === "PAYMENT_SUBMITTED" ? waitingPaymentId(ticket.id) : null,
    getTicketDispute(supabase, ticket.id),
    listComments(supabase, ticket.id),
    supabase.from("owner_company_profiles").select("company_name").eq("owner_id", owner.id).maybeSingle(),
  ]);
  const record = dispute?.status === "OPEN" && inv?.id ? await getReadingRecord(supabase, inv.id) : null;
  const state = { status: ticket.status, statusBeforeOverdue: ticket.status_before_overdue };
  const canCorrect = ticket.status !== "DISPUTED" && canPerform("correctInvoice", "OWNER", state) && Boolean(inv?.invoice_no);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/owner/tickets" label="Tickets" />
        <PageHeader
          title={`Cycle ${ticket.cycle_no} · ${formatDate(ticket.cycle_date)}`}
          description={`${ticket.customer.name} · ${ticket.machine.brand} ${ticket.machine.model} (${ticket.machine.serial_no})`}
        />
        <div className="-mt-3 flex flex-wrap gap-2">
          <TicketStatusBadge status={ticket.status} before={ticket.status_before_overdue} />
          <TicketFlagBadges ticket={ticket} now={now} />
          {ticket.is_late && <span className="text-sm text-muted-foreground">Reading came late</span>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Now</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">Who acts</dt>
              <dd className="font-medium" data-testid="ticket-who">
                {step.who === "OWNER" ? "You" : step.who === "CUSTOMER" ? ticket.customer.name : "Nobody"}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Next step</dt>
              <dd className="font-medium">{step.label}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Due</dt>
              <dd className="font-medium">{dueText(currentDue(ticket))}</dd>
            </div>
          </dl>
          {ticket.status === "PENDING_OWNER_REVIEW" && (
            <Link href={`/owner/tickets/${ticket.id}/review`} className={cn(buttonVariants(), "mt-4 h-12 w-full text-base sm:w-auto sm:px-6")}>
              {ticket.invoice?.type === "ESTIMATED" ? "Review the estimated invoice" : "Review the reading"}
            </Link>
          )}
          {waiting && (
            <Link href={`/owner/payments/${waiting}`} className={cn(buttonVariants(), "mt-4 h-12 w-full text-base sm:w-auto sm:px-6")} data-testid="ticket-check-payment">
              Check the payment slip
            </Link>
          )}
          {isMeterStage({ status: ticket.status, statusBeforeOverdue: ticket.status_before_overdue }) && (
            <Link href={`/owner/tickets/${ticket.id}/enter`} className={cn(buttonVariants({ variant: "outline" }), "mt-4 h-12 w-full text-base sm:w-auto sm:px-6")}>
              Enter the reading for the customer
            </Link>
          )}
          <div className="mt-4">
            <OwnerTicketActions ticketId={ticket.id} status={ticket.status} before={ticket.status_before_overdue} today={todayInColombo()} action={ticketAction} />
          </div>
          {canCorrect && (
            <Link href={`/owner/tickets/${ticket.id}/correct`} className={cn(buttonVariants({ variant: "outline" }), "mt-2 h-12 w-full text-base sm:w-auto sm:px-6")} data-testid="correct-bill">
              Correct the bill
            </Link>
          )}
          {ticket.status === "CLOSED" && inv?.invoice_no && (
            <p className="mt-2 text-sm text-muted-foreground">To correct a bill that was already paid, reopen the ticket first (with a reason).</p>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            Period {formatDate(ticket.period_start)} to {formatDate(ticket.period_end)} ({ticket.cycle_length_days} days).{" "}
            <Link href={`/owner/agreements/${ticket.agreement_id}`} className="underline underline-offset-4">
              Agreement
            </Link>
          </p>
        </CardContent>
      </Card>

      {inv && (
        <Card>
          <CardHeader>
            <CardTitle>{inv.type === "ESTIMATED" ? "Estimated invoice" : "Invoice"}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="font-medium">{inv.invoice_no ?? "Draft (not numbered yet)"}</p>
              <p className="text-sm text-muted-foreground">
                {INVOICE_STATUS_LABEL[inv.status] ?? inv.status}
                {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ""}
                {inv.amount_paid_cents > 0 ? ` · ${formatRupees(inv.amount_paid_cents)} paid` : ""}
              </p>
            </div>
            <p className="text-2xl font-semibold tabular-nums">{formatRupees(inv.total_cents)}</p>
            {inv.invoice_no && inv.id && (
              <Link href={`/owner/invoices/${inv.id}`} className={cn(buttonVariants({ variant: "outline" }), "h-11 w-full text-base sm:w-auto")}>
                Open invoice and PDF
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {dispute && (
        <DisputeCard dispute={dispute} audience="owner" invoiceHref="/owner/invoices" record={record}>
          {ticket.status === "DISPUTED" && (
            <OwnerDisputeActions
              ticketId={ticket.id}
              today={todayInColombo()}
              leftToPayCents={inv ? inv.total_cents - inv.amount_paid_cents : 0}
              photoPending={Boolean(dispute.photo && !dispute.photo.receivedAt)}
              action={disputeAction}
            />
          )}
        </DisputeCard>
      )}

      <Card>
        <CardContent>
          <CommentThread
            ticketId={ticket.id}
            viewerId={owner.id}
            comments={comments}
            names={{ owner: company.data?.company_name ?? "Rental company", customer: ticket.customer.name }}
            add={addCommentAction}
            edit={editCommentAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <TicketTimeline events={ticket.events} />
        </CardContent>
      </Card>
    </div>
  );
}
