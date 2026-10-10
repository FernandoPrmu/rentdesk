import type { IsoDate } from "../agreements/cycle-calendar.ts";
import { type LateFeeMode, lateFeeDue, type LateFeeSources, resolveLateFee } from "../billing/late-fee.ts";
import {
  colomboDate,
  dueReminder,
  meterDeadline,
  meterReminders,
  overdueReminders,
  ownerReviewEscalation,
  ownerReviewReminders,
  paymentReminders,
  reached,
  type ReminderMilestone,
  type StageSettings,
} from "../tickets/deadlines.ts";
import { isMeterStage, isPaymentStage, type TicketStatus } from "../tickets/states.ts";

/**
 * What the daily job does to one open ticket at `now` (spec 5.4, 8.3, 11; rules
 * 20-24). Pure, so it is unit-tested with a fake clock; daily.ts turns each
 * decision into an rpc call. Each rpc is a compare-and-set, so a decision that
 * is already done (second run the same day) changes nothing.
 * Only relative imports.
 */

export interface CronInvoice {
  id: string;
  invoice_no: string | null;
  type: "NORMAL" | "ESTIMATED";
  status: string;
  due_date: IsoDate | null;
  subtotal_cents: number;
  late_fee_cents: number;
  credit_applied_cents: number;
  total_cents: number;
  amount_paid_cents: number;
}

/** One row of rpc_cron_ticket_candidates. */
export interface CronTicket {
  id: string;
  owner_id: string;
  customer_id: string;
  agreement_id: string;
  cycle_no: number;
  cycle_date: IsoDate;
  status: TicketStatus;
  status_before_overdue: TicketStatus | null;
  stage_due_at: string | null;
  stage_entered_at: string;
  escalation_level: number;
  reminder_count: number;
  paused_at: string | null;
  machine_type: "MONO" | "COLOUR";
  commitment_cents: number;
  bw_included: number;
  bw_rate_cents: number;
  colour_included: number | null;
  colour_rate_cents: number | null;
  late_fee_mode: LateFeeMode;
  late_fee_cents: number | null;
  machine_name: string;
  serial_no: string;
  customer_name: string;
  accounts_active: boolean;
  has_estimate: boolean;
  invoice: CronInvoice | null;
  settings: StageSettings;
  owner_late_fee: { enabled: boolean | null; fee_cents: number | null; grace_days: number | null };
  credits: { id: string; available_cents: number; kind: string }[] | null;
}

export interface PlatformLateFee {
  enabled: boolean;
  fee_cents: number;
  grace_days: number;
}

export type Decision =
  /** Customer stage missed its deadline; `reminderNo` = overdue reminders already covered by this notice. */
  | { kind: "MARK_OVERDUE"; stage: "METER" | "PAYMENT"; reminderNo: number }
  /** Spec 11.6: estimated invoice (draft) for the owner. */
  | { kind: "ESTIMATE" }
  | { kind: "REMIND"; reminder: ReminderMilestone; recipient: "CUSTOMER" | "OWNER" }
  /** Owner did not act on a reading or slip: admin alerted (level 2). */
  | { kind: "ESCALATE_ADMIN"; hours: number }
  | { kind: "LATE_FEE"; feeCents: number };

/** Admin escalation level; 1 = owner alerted (customer stages). */
export const ESCALATION_OWNER = 1;
export const ESCALATION_ADMIN = 2;

export function lateFeeSources(t: CronTicket, platform: PlatformLateFee): LateFeeSources {
  return {
    agreement: { mode: t.late_fee_mode, feeCents: t.late_fee_cents },
    owner: { enabled: t.owner_late_fee.enabled, feeCents: t.owner_late_fee.fee_cents, graceDays: t.owner_late_fee.grace_days },
    platform: { enabled: platform.enabled, feeCents: platform.fee_cents, graceDays: platform.grace_days },
  };
}

function unpaid(inv: CronInvoice | null): inv is CronInvoice & { due_date: IsoDate } {
  return inv !== null && inv.due_date !== null && inv.amount_paid_cents < inv.total_cents;
}

export function decideTicket(t: CronTicket, now: Date, platform: PlatformLateFee): Decision[] {
  // Paused (11.8): frozen until the accounts are active again (pause sync runs first).
  if (t.paused_at !== null || !t.accounts_active) return [];
  const s = t.settings;
  const today = colomboDate(now);
  const entered = new Date(t.stage_entered_at);
  const out: Decision[] = [];
  const state = { status: t.status, statusBeforeOverdue: t.status_before_overdue };

  if (t.status === "METER_REQUESTED") {
    const deadline = t.stage_due_at ? new Date(t.stage_due_at) : meterDeadline(entered, s);
    if (deadline.getTime() <= now.getTime()) {
      out.push({ kind: "MARK_OVERDUE", stage: "METER", reminderNo: 0 });
      if (s.estimated_billing_enabled && !t.has_estimate) out.push({ kind: "ESTIMATE" });
      return out;
    }
    const reminder = dueReminder(
      meterReminders(entered, s).filter((r) => r.at.getTime() < deadline.getTime()),
      t.reminder_count,
      now,
    );
    if (reminder) out.push({ kind: "REMIND", reminder, recipient: "CUSTOMER" });
    return out;
  }

  if (t.status === "OVERDUE" && isMeterStage(state)) {
    if (s.estimated_billing_enabled && !t.has_estimate) out.push({ kind: "ESTIMATE" });
    return out;
  }

  if (t.status === "PENDING_OWNER_REVIEW" || t.status === "PAYMENT_SUBMITTED") {
    const kind = t.status === "PENDING_OWNER_REVIEW" ? "REVIEW" : "SLIP_REVIEW";
    const reminder = dueReminder(ownerReviewReminders(entered, s, kind), t.reminder_count, now);
    if (reminder) out.push({ kind: "REMIND", reminder, recipient: "OWNER" });
    if (t.escalation_level < ESCALATION_ADMIN && reached(ownerReviewEscalation(entered, s, kind), now)) {
      out.push({ kind: "ESCALATE_ADMIN", hours: kind === "REVIEW" ? s.review_escalation_hours : s.slip_review_escalation_hours });
    }
    return out;
  }

  if (isPaymentStage(state) && unpaid(t.invoice)) {
    const inv = t.invoice;
    if (t.status !== "OVERDUE") {
      if (today > inv.due_date) {
        // The first overdue reminder (day 1) is the overdue notice itself.
        const sent = dueReminder(overdueReminders(inv.due_date, s), 0, now);
        out.push({ kind: "MARK_OVERDUE", stage: "PAYMENT", reminderNo: sent?.no ?? 0 });
      } else if (t.status !== "REOPENED") {
        // A reopened ticket waits for the owner (spec 5.3); no reminders to the customer.
        const reminder = dueReminder(paymentReminders(inv.due_date, s), t.reminder_count, now);
        if (reminder) out.push({ kind: "REMIND", reminder, recipient: "CUSTOMER" });
      }
    } else {
      const reminder = dueReminder(overdueReminders(inv.due_date, s), t.reminder_count, now);
      if (reminder) out.push({ kind: "REMIND", reminder, recipient: "CUSTOMER" });
    }

    // PAY-13 / LATE-01: once, after the grace period (never with a slip waiting or a dispute:
    // those statuses never reach this branch).
    const fee = resolveLateFee(lateFeeSources(t, platform));
    const due = lateFeeDue(
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
      fee,
      today,
    );
    if (due) out.push({ kind: "LATE_FEE", feeCents: fee.feeCents });
  }
  return out;
}

