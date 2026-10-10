import { calculateInvoice } from "../billing/invoice.ts";
import { addLateFee } from "../billing/late-fee.ts";
import { admins, customer, type NotificationContext, notificationsFor, owner } from "../notifications/service.ts";
import { colomboDate, lastDayBefore, meterDeadline, reviewDeadline } from "../tickets/deadlines.ts";
import {
  createEstimate,
  type EstimatePayload,
  markOverdue,
  openCycle,
  type Rpc,
  RpcError,
  SYSTEM,
  type TicketSnapshot,
  TransitionError,
} from "../tickets/transitions.ts";
import { type CronTicket, decideTicket, type Decision, ESCALATION_ADMIN, ESCALATION_OWNER, type PlatformLateFee } from "./decide.ts";

/**
 * The daily job (spec 5.4, 5.5, 8.3, 11; TKT-01, TKT-05, TKT-07, TKT-08, TKT-12,
 * PAY-10, PAY-13). Called by /api/cron/daily (Vercel Cron, once a day), the
 * admin's "Run daily job now" button and `npm run cron:run`.
 *
 * Steps, in order: pause/resume tickets of suspended accounts, open due cycles
 * (catching up every missed one), the ticket sweep (overdue, estimate, reminders,
 * escalation, late fee), meter photo purge, weekly overdue summaries.
 *
 * - Idempotent: every write is a compare-and-set rpc; a second run the same day
 *   finds nothing to do.
 * - Batches with a time budget: when the budget runs out the run stops between
 *   items, is recorded as PARTIAL with `remaining`, and the next run continues.
 * - Every run is recorded in cron_runs (start, end, counts, errors).
 *
 * The database is reached only through `rpc` (public.rpc_* wrappers), so DB tests
 * drive the same code inside a rolled-back transaction with a simulated clock.
 * Only relative imports.
 */

export interface PhotoStorage {
  /** Deletes meter photo objects; a missing object is not an error. */
  removeMeterPhotos(paths: string[]): Promise<void>;
}

export interface DailyJobOptions {
  now: Date;
  /** The "now" was overridden (non-production only). */
  simulated?: boolean;
  trigger: "CRON" | "ADMIN" | "LOCAL";
  triggeredBy?: string | null;
  /** Stop starting new work after this many ms (Vercel Hobby function limit). */
  budgetMs?: number;
  batchSize?: number;
  /** Elapsed-time source for the budget (tests). */
  clock?: () => number;
}

export const COUNT_KEYS = [
  "opened",
  "flaggedOverdue",
  "reminders",
  "overdue",
  "escalated",
  "estimated",
  "lateFees",
  "paused",
  "resumed",
  "photosDeleted",
  "summaries",
  "skipped",
] as const;
export type CronCounts = Record<(typeof COUNT_KEYS)[number], number>;

export interface CronErrorEntry {
  step: string;
  id?: string;
  code?: string;
  message: string;
}

export interface DailyJobResult {
  runId: string | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED";
  counts: CronCounts;
  errors: CronErrorEntry[];
  remaining: boolean;
}

const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_BATCH = 50;
const MAX_ERRORS = 50;

class OutOfTime extends Error {}

function errorEntry(step: string, id: string | undefined, error: unknown): CronErrorEntry {
  if (error instanceof RpcError || error instanceof TransitionError) return { step, id, code: error.code, message: error.message };
  return { step, id, message: error instanceof Error ? error.message : String(error) };
}

function ticketContext(t: CronTicket, extra: NotificationContext = {}): NotificationContext {
  return { machine: `${t.machine_name} (${t.serial_no})`, customer: t.customer_name, cycleNo: t.cycle_no, ...extra };
}

function snapshot(t: CronTicket): TicketSnapshot {
  return {
    id: t.id,
    owner_id: t.owner_id,
    customer_id: t.customer_id,
    cycle_no: t.cycle_no,
    status: t.status,
    status_before_overdue: t.status_before_overdue,
    machine_name: t.machine_name,
    customer_name: t.customer_name,
  };
}

const REMINDER_EVENT = {
  METER: "ticket.meter_reminder",
  REVIEW: "ticket.review_reminder",
  SLIP_REVIEW: "ticket.slip_reminder",
  PAYMENT_DUE_SOON: "payment.due_soon",
  PAYMENT_DUE_TODAY: "payment.due_today",
  PAYMENT_OVERDUE: "payment.overdue",
} as const;

/** The estimated invoice for a ticket (commitment only, credits auto-applied: rule 13). */
export function buildEstimate(t: CronTicket): EstimatePayload {
  const CREDIT_LABEL: Record<string, string> = {
    ADVANCE: "advance payment",
    OVERPAYMENT: "overpayment",
    CANCELLED_INVOICE: "paid on a cancelled invoice",
    ESTIMATE_RECONCILIATION: "estimate",
    MANUAL: "credit",
  };
  const result = calculateInvoice({
    terms: {
      machineType: t.machine_type,
      commitmentCents: t.commitment_cents,
      bwIncluded: t.bw_included,
      bwRateCents: t.bw_rate_cents,
      colourIncluded: t.colour_included,
      colourRateCents: t.colour_rate_cents,
    },
    kind: "ESTIMATED",
    fullCycles: 1,
    credits: (t.credits ?? []).map((c) => ({ id: c.id, amountCents: c.available_cents, label: CREDIT_LABEL[c.kind] })),
  });
  return {
    type: "ESTIMATED",
    cycles_covered: result.cyclesCovered,
    subtotal_cents: result.subtotalCents,
    credit_applied_cents: result.creditAppliedCents,
    total_cents: result.totalCents,
    lines: result.lines,
    calculation: result.calculation,
  };
}

export async function runDailyJob(rpc: Rpc, storage: PhotoStorage, options: DailyJobOptions): Promise<DailyJobResult> {
  const clock = options.clock ?? (() => Date.now());
  const started = clock();
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const batch = options.batchSize ?? DEFAULT_BATCH;
  const now = options.now;
  const today = colomboDate(now);
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as CronCounts;
  const errors: CronErrorEntry[] = [];
  let remaining = false;

  const record = (entry: CronErrorEntry) => {
    if (errors.length < MAX_ERRORS) errors.push(entry);
  };
  const checkTime = () => {
    if (clock() - started > budget) {
      remaining = true;
      throw new OutOfTime();
    }
  };
  const skippedOrDone = (result: unknown) => {
    const skipped = typeof result === "object" && result !== null && "skipped" in result && (result as { skipped?: unknown }).skipped;
    if (skipped) counts.skipped += 1;
    return !skipped;
  };

  const begun = (await rpc("rpc_cron_begin_run", {
    p_job: "daily",
    p_trigger: options.trigger,
    p_triggered_by: options.triggeredBy ?? null,
    p_now: now.toISOString(),
    p_simulated: options.simulated ?? false,
  })) as { run_id: string; skipped: boolean };
  if (begun.skipped) {
    return { runId: begun.run_id, status: "SKIPPED", counts, errors: [{ step: "run", message: "Another run is in progress" }], remaining: false };
  }

  let fatal: unknown = null;
  try {
    const ctx = (await rpc("rpc_cron_context", {})) as { admin_ids: string[]; platform_late_fee: PlatformLateFee };

    // h. Pause / resume (TKT-12). First, so the sweep below sees the right state.
    await syncPauses(rpc, now, null, batch, counts, record, checkTime);

    // a. Open due cycles from the monthly calendar (TKT-01, TKT-07), catching up.
    const attempted = new Set<string>();
    for (;;) {
      checkTime();
      const due = (await rpc("rpc_cron_due_agreements", { p_today: today, p_limit: batch })) as {
        agreement_id: string;
        owner_id: string;
        customer_id: string;
        next_cycle_no: number;
        machine_name: string;
        serial_no: string;
        meter_deadline_days: number;
      }[];
      const fresh = due.filter((a) => !attempted.has(`${a.agreement_id}:${a.next_cycle_no}`));
      if (fresh.length === 0) break;
      for (const a of fresh) {
        checkTime();
        attempted.add(`${a.agreement_id}:${a.next_cycle_no}`);
        const deadline = meterDeadline(now, { meter_deadline_days: a.meter_deadline_days });
        try {
          const r = await openCycle(rpc, SYSTEM, {
            agreementId: a.agreement_id,
            cycleNo: a.next_cycle_no,
            ownerId: a.owner_id,
            customerId: a.customer_id,
            stageDueAt: deadline,
            now,
            context: { machine: `${a.machine_name} (${a.serial_no})`, cycleNo: a.next_cycle_no, byDate: lastDayBefore(deadline) },
          });
          if (r.ticket_id && !r.replayed) counts.opened += 1;
          else counts.skipped += 1;
          counts.flaggedOverdue += r.flagged_overdue?.length ?? 0;
        } catch (error) {
          record(errorEntry("open", a.agreement_id, error));
        }
      }
    }

    // b-f. Ticket sweep.
    let after: string | null = null;
    for (;;) {
      checkTime();
      const tickets = (await rpc("rpc_cron_ticket_candidates", { p_after: after, p_limit: batch })) as CronTicket[];
      for (const t of tickets) {
        checkTime();
        try {
          await applyDecisions(rpc, t, decideTicket(t, now, ctx.platform_late_fee), now, ctx.admin_ids, counts, skippedOrDone);
        } catch (error) {
          record(errorEntry("ticket", t.id, error));
        }
      }
      if (tickets.length < batch) break;
      after = tickets[tickets.length - 1].id;
    }

    // g. Meter photos: confirmed (deleted on confirm, INV-09) and expired rejected attempts (6.5).
    for (;;) {
      checkTime();
      const photos = (await rpc("rpc_cron_expired_photos", { p_now: now.toISOString(), p_limit: batch })) as { id: string; storage_path: string }[];
      if (photos.length === 0) break;
      try {
        await storage.removeMeterPhotos(photos.map((p) => p.storage_path));
        counts.photosDeleted += (await rpc("rpc_mark_photos_deleted", { p_ids: photos.map((p) => p.id), p_now: now.toISOString() })) as number;
      } catch (error) {
        record(errorEntry("photos", undefined, error));
        break;
      }
      if (photos.length < batch) break;
    }

    // Rule 30: photos uploaded but never submitted, older than 2 days. One batch per run:
    // nothing records them, so a failed removal must not be retried in a loop.
    checkTime();
    const orphans = (await rpc("rpc_cron_orphan_photos", { p_now: now.toISOString(), p_limit: batch })) as string[];
    if (orphans.length > 0) {
      try {
        await storage.removeMeterPhotos(orphans);
        counts.photosDeleted += orphans.length;
      } catch (error) {
        record(errorEntry("orphan photos", undefined, error));
      }
    }

    // Weekly overdue summary to owners (spec 5.4, 8.3).
    checkTime();
    const summaries = (await rpc("rpc_cron_overdue_summaries", { p_today: today })) as {
      owner_id: string;
      week_of: string;
      invoice_count: number;
      outstanding_cents: number;
    }[];
    for (const s of summaries) {
      checkTime();
      try {
        const r = await rpc("rpc_notify_once", {
          p_owner_id: s.owner_id,
          p_dedupe_key: `overdue-summary:${s.week_of}`,
          p_notifications: notificationsFor("payment.overdue_summary", [owner(s.owner_id)], { count: s.invoice_count, amountCents: s.outstanding_cents }, {
            link: "/owner/tickets?status=OVERDUE",
            data: { week_of: s.week_of },
          }),
        });
        if (skippedOrDone(r)) counts.summaries += 1;
      } catch (error) {
        record(errorEntry("summary", s.owner_id, error));
      }
    }
  } catch (error) {
    if (!(error instanceof OutOfTime)) {
      fatal = error;
      record(errorEntry("run", undefined, error));
    }
  }

  const status: DailyJobResult["status"] = fatal ? "FAILED" : remaining || errors.length > 0 ? "PARTIAL" : "SUCCESS";
  await rpc("rpc_cron_finish_run", { p_run_id: begun.run_id, p_status: status, p_counts: counts, p_errors: errors, p_remaining: remaining });
  return { runId: begun.run_id, status, counts, errors, remaining };
}

async function applyDecisions(
  rpc: Rpc,
  t: CronTicket,
  decisions: Decision[],
  now: Date,
  adminIds: string[],
  counts: CronCounts,
  done: (result: unknown) => boolean,
) {
  let ticket = snapshot(t);
  const inv = t.invoice;
  for (const d of decisions) {
    switch (d.kind) {
      case "MARK_OVERDUE": {
        const r = await markOverdue(rpc, SYSTEM, ticket, {
          now,
          reminderNo: d.reminderNo,
          escalationLevel: ESCALATION_OWNER,
          context: ticketContext(t, inv ? { amountCents: inv.total_cents - inv.amount_paid_cents, dueDate: inv.due_date ?? undefined, invoiceNo: inv.invoice_no } : {}),
        });
        if (!done(r)) return; // someone acted meanwhile: decide again tomorrow
        counts.overdue += 1;
        ticket = { ...ticket, status: "OVERDUE", status_before_overdue: ticket.status };
        break;
      }
      case "ESTIMATE": {
        const invoice = buildEstimate(t);
        const r = await createEstimate(rpc, SYSTEM, ticket, { invoice, stageDueAt: reviewDeadline(now, t.settings), now, context: ticketContext(t) });
        if (done(r)) counts.estimated += 1;
        return;
      }
      case "REMIND": {
        const recipient = d.recipient === "CUSTOMER" ? customer(t.customer_id) : owner(t.owner_id);
        const byDate = t.stage_due_at && d.reminder.kind === "METER" ? lastDayBefore(new Date(t.stage_due_at)) : undefined;
        const r = await rpc("rpc_record_ticket_reminder", {
          p_ticket_id: t.id,
          p_status: t.status,
          p_reminder_no: d.reminder.no,
          p_now: now.toISOString(),
          p_metadata: { kind: d.reminder.kind, day_offset: d.reminder.dayOffset ?? null },
          p_notifications: notificationsFor(
            REMINDER_EVENT[d.reminder.kind],
            [recipient],
            ticketContext(t, {
              byDate,
              amountCents: inv ? inv.total_cents - inv.amount_paid_cents : undefined,
              dueDate: inv?.due_date ?? undefined,
              invoiceNo: inv?.invoice_no,
            }),
          ),
        });
        if (done(r)) counts.reminders += 1;
        break;
      }
      case "ESCALATE_ADMIN": {
        const r = await rpc("rpc_escalate_ticket", {
          p_ticket_id: t.id,
          p_status: t.status,
          p_level: ESCALATION_ADMIN,
          p_now: now.toISOString(),
          p_reason: `Owner has not acted for ${d.hours} hours`,
          p_notifications: notificationsFor("ticket.escalated", admins(adminIds), ticketContext(t, { hours: d.hours })),
        });
        if (done(r)) counts.escalated += 1;
        break;
      }
      case "LATE_FEE": {
        if (!inv?.due_date) break;
        const fee = addLateFee(
          {
            status: inv.status,
            dueDate: inv.due_date,
            subtotalCents: inv.subtotal_cents,
            lateFeeCents: inv.late_fee_cents,
            creditAppliedCents: inv.credit_applied_cents,
            totalCents: inv.total_cents,
            amountPaidCents: inv.amount_paid_cents,
            slipAwaitingVerification: false,
          },
          d.feeCents,
        );
        const r = await rpc("rpc_apply_late_fee", {
          p_ticket_id: t.id,
          p_invoice_id: inv.id,
          p_line: fee.line,
          p_total_cents: fee.totalCents,
          p_now: now.toISOString(),
          p_notifications: notificationsFor(
            "invoice.late_fee",
            [customer(t.customer_id), owner(t.owner_id)],
            ticketContext(t, { amountCents: d.feeCents, invoiceNo: inv.invoice_no }),
          ),
        });
        if (done(r)) counts.lateFees += 1;
        break;
      }
    }
  }
}

/**
 * TKT-12 / spec 11.8: freeze the open tickets of a suspended customer or owner,
 * and resume them (deadlines moved forward) once both are active. Also called
 * right after an account status change, scoped to that owner.
 */
export async function syncPauses(
  rpc: Rpc,
  now: Date,
  ownerId: string | null,
  batch: number,
  counts: Pick<CronCounts, "paused" | "resumed" | "skipped">,
  record: (e: CronErrorEntry) => void = () => {},
  checkTime: () => void = () => {},
) {
  const seen = new Set<string>();
  for (;;) {
    checkTime();
    const rows = (await rpc("rpc_cron_pause_candidates", { p_owner_id: ownerId, p_limit: batch })) as {
      id: string;
      customer_id: string;
      action: "PAUSE" | "RESUME";
      customer_status: string;
      owner_status: string;
      machine_name: string;
    }[];
    const fresh = rows.filter((r) => !seen.has(`${r.id}:${r.action}`));
    if (fresh.length === 0) return;
    for (const r of fresh) {
      checkTime();
      seen.add(`${r.id}:${r.action}`);
      const pause = r.action === "PAUSE";
      const who = r.owner_status !== "ACTIVE" ? "Owner" : "Customer";
      const status = (pause ? (r.owner_status !== "ACTIVE" ? r.owner_status : r.customer_status) : "ACTIVE").toLowerCase();
      try {
        const result = await rpc("rpc_set_ticket_pause", {
          p_ticket_id: r.id,
          p_pause: pause,
          p_now: now.toISOString(),
          p_reason: pause ? `${who} account ${status}` : "Accounts active again",
          p_notifications: pause ? [] : notificationsFor("ticket.resumed", [customer(r.customer_id)], { machine: r.machine_name }),
        });
        const skipped = typeof result === "object" && result !== null && "skipped" in result;
        if (skipped) counts.skipped += 1;
        else if (pause) counts.paused += 1;
        else counts.resumed += 1;
      } catch (error) {
        record(errorEntry("pause", r.id, error));
      }
    }
  }
}

/** Short summary for logs and the admin page. */
export function describeCounts(c: CronCounts): string {
  const parts = COUNT_KEYS.filter((k) => c[k] > 0).map((k) => `${k} ${c[k]}`);
  return parts.length ? parts.join(", ") : "nothing to do";
}
