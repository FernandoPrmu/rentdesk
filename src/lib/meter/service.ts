import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadMeterContext } from "@/lib/billing/context";
import type { MeterContext } from "@/lib/billing/meter-invoice";
import { previousReading } from "@/lib/billing/usage";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { onInvoiceIssued } from "@/lib/invoices/issued";
import { describeChange, previewReading, type ReadingErrors } from "@/lib/meter/readings";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  invoiceDueDate,
  lastDayBefore,
  meterDeadline,
  paymentDeadline,
  PLATFORM_DEFAULTS,
  rejectedPhotoExpiry,
  reviewDeadline,
  type StageSettings,
} from "@/lib/tickets/deadlines";
import { isMeterStage, type TicketStatus } from "@/lib/tickets/states";
import {
  confirmInvoice,
  correctReading,
  enterReadingManually,
  rejectReading,
  RpcError,
  submitReading,
  type TicketSnapshot,
  TransitionError,
} from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

/**
 * Meter reading and the owner's review (INV-01..14, CP-03, spec 6, 11.2, 11.3).
 * Server side of the customer's meter entry, the owner's review, correction and
 * manual entry. Every amount comes from the billing engine (src/lib/billing); every
 * change goes through a transition function and its atomic rpc, which checks it
 * all again. Ownership is checked here first: another tenant's ticket looks
 * exactly like a missing one.
 */

type Admin = SupabaseClient<Database>;

export const PHOTO_BUCKET = "meter-photos";
const MAX_PHOTO_BYTES = 1024 * 1024;
const SIGNED_URL_SECONDS = 5 * 60;

interface TicketRow extends TicketSnapshot {
  agreement_id: string;
  cycle_date: string;
  period_start: string;
  period_end: string;
  machine_type: "MONO" | "COLOUR";
  stage_due_at: string | null;
  paused_at: string | null;
  rejection_count: number;
  due_days: number;
  current_invoice_id: string | null;
  serial_no: string;
}

async function loadTicket(admin: Admin, ticketId: string): Promise<TicketRow | null> {
  const { data, error } = await admin
    .from("billing_cycle_tickets")
    .select(
      `id, owner_id, customer_id, agreement_id, cycle_no, cycle_date, period_start, period_end, status, status_before_overdue,
       machine_type, stage_due_at, paused_at, rejection_count, due_days, current_invoice_id,
       machine:machines!billing_cycle_tickets_machine_fkey(brand, model, serial_no),
       customer:customers!billing_cycle_tickets_customer_fkey(name)`,
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw new Error(`ticket: ${error.message}`);
  if (!data) return null;
  return {
    ...data,
    status: data.status as TicketStatus,
    status_before_overdue: data.status_before_overdue as TicketStatus | null,
    machine_name: `${data.machine.brand} ${data.machine.model}`,
    serial_no: data.machine.serial_no,
    customer_name: data.customer.name,
    // Tickets snapshot the agreement's days to pay; older tickets fall back to the default (rule 15).
    due_days: data.due_days ?? PLATFORM_DEFAULTS.payment_due_days,
  };
}

async function settingsFor(admin: Admin, ownerId: string): Promise<StageSettings> {
  const { data, error } = await admin.from("owner_settings_effective").select("*").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error(`settings: ${error.message}`);
  return data ? ({ ...PLATFORM_DEFAULTS, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) } as StageSettings) : PLATFORM_DEFAULTS;
}

/** Workflow refusals in plain words (the SQL prefixes a stable code). */
function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof TransitionError) return fail(error.message.replace(/^[^:]+: /, ""));
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, context));
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again.");
}

function previousValues(context: MeterContext) {
  return {
    BW: context.counters.BW ? previousReading(context.counters.BW.known).value : null,
    COLOUR: context.counters.COLOUR ? previousReading(context.counters.COLOUR.known).value : null,
  };
}

// -----------------------------------------------------------------------------
// Customer: meter entry (INV-01..06, INV-13, INV-14, CP-03)
// -----------------------------------------------------------------------------

export interface MeterEntryView {
  ticketId: string;
  ownerId: string;
  machine: string;
  serialNo: string;
  machineType: "MONO" | "COLOUR";
  cycleNo: number;
  periodStart: string;
  periodEnd: string;
  /** Months this reading covers (rule 12). */
  months: number;
  /** Last day to send it (null when overdue already). */
  byDate: string | null;
  overdue: boolean;
  previous: { BW: number | null; COLOUR: number | null };
  context: MeterContext;
  /** Why the customer cannot send a reading now, or null. */
  blocked: string | null;
  lastRejection: string | null;
}

export async function getMeterEntry(user: CurrentUser, ticketId: string): Promise<MeterEntryView | null> {
  const admin = createAdminClient();
  const t = await loadTicket(admin, ticketId);
  if (!t || t.customer_id !== user.id) return null;
  const [context, settings, rejected] = await Promise.all([
    loadMeterContext(admin, ticketId),
    settingsFor(admin, t.owner_id),
    admin.from("meter_submissions").select("reject_reason").eq("ticket_id", t.id).eq("status", "REJECTED").order("attempt_no", { ascending: false }).limit(1),
  ]);
  const meter = isMeterStage({ status: t.status, statusBeforeOverdue: t.status_before_overdue });
  const blocked = !meter
    ? "This ticket is not waiting for a meter reading."
    : t.paused_at
      ? "This ticket is on hold."
      : t.rejection_count >= settings.max_meter_rejections
        ? "Your rental company will enter this reading for you."
        : null;
  return {
    ticketId: t.id,
    ownerId: t.owner_id,
    machine: t.machine_name ?? "",
    serialNo: t.serial_no,
    machineType: t.machine_type,
    cycleNo: t.cycle_no,
    periodStart: t.period_start,
    periodEnd: t.period_end,
    months: context.cyclesCovered,
    byDate: t.stage_due_at ? lastDayBefore(new Date(t.stage_due_at)) : null,
    overdue: t.status === "OVERDUE" || (t.stage_due_at !== null && Date.parse(t.stage_due_at) <= Date.now()),
    previous: previousValues(context),
    context,
    blocked,
    lastRejection: rejected.data?.[0]?.reject_reason ?? null,
  };
}

export const customerReadingSchema = z.object({
  ticketId: z.uuid(),
  idempotencyKey: z.uuid(),
  bw: z.string().max(20),
  colour: z.string().max(20).default(""),
  photoPath: z.string().min(1).max(300),
  capturedAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

/** The photo the browser uploaded: in this ticket's folder, a JPEG, not too large (rule 30). */
async function checkPhoto(admin: Admin, t: TicketRow, path: string): Promise<string | null> {
  if (!new RegExp(`^${t.owner_id}/${t.id}/[0-9a-f-]{36}\\.jpg$`).test(path)) return "The photo is not for this ticket.";
  const { data, error } = await admin.storage.from(PHOTO_BUCKET).download(path);
  if (error || !data) return "The photo did not arrive. Please try again.";
  if (data.size > MAX_PHOTO_BYTES) return "The photo is too large. Please take it again.";
  const head = new Uint8Array(await data.slice(0, 3).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return "The photo is not a camera picture. Please take it again.";
  return null;
}

export async function submitCustomerReading(
  user: CurrentUser,
  input: z.input<typeof customerReadingSchema>,
): Promise<ActionResult<{ replayed: boolean }> & { fieldErrors?: ReadingErrors }> {
  const parsed = customerReadingSchema.safeParse(input);
  if (!parsed.success) return fail("Please check the reading and try again.");
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const t = await loadTicket(admin, i.ticketId);
    if (!t || t.customer_id !== user.id) return fail("This ticket was not found.");

    // A retry of a submission that already went through returns its result (INV-13).
    const { data: earlier } = await admin.from("meter_submissions").select("id, ticket_id").eq("idempotency_key", i.idempotencyKey).maybeSingle();
    if (earlier) return earlier.ticket_id === t.id ? ok({ replayed: true }) : fail("Please reload the page and try again.");

    const photoProblem = await checkPhoto(admin, t, i.photoPath);
    if (photoProblem) return fail(photoProblem);

    const context = await loadMeterContext(admin, t.id);
    const preview = previewReading(context, { bw: i.bw, colour: i.colour });
    if (!preview.ok) return { ...fail(preview.message ?? "Please check the reading."), fieldErrors: preview.errors };

    const settings = await settingsFor(admin, t.owner_id);
    const s = preview.submission;
    const result = (await submitReading(supabaseRpc(admin), { kind: "USER", id: user.id, role: "CUSTOMER" }, t, {
      idempotencyKey: i.idempotencyKey,
      readings: s.readings,
      invoice: s.invoice,
      anomalyFlag: s.anomalyFlag,
      photo: { storagePath: i.photoPath, capturedAt: i.capturedAt ? new Date(i.capturedAt) : undefined },
      stageDueAt: reviewDeadline(new Date(), settings),
    })) as { replayed?: boolean };
    return ok({ replayed: Boolean(result.replayed) });
  } catch (error) {
    return failure(error, "meter submit");
  }
}

// -----------------------------------------------------------------------------
// Owner: review, confirm, reject, correct, enter manually (INV-07..12)
// -----------------------------------------------------------------------------

export interface ReviewReading {
  counter: "BW" | "COLOUR";
  previous: number;
  current: number;
  correctedFrom: number | null;
  correctionNote: string | null;
  rolledOver: boolean;
}

export interface ReviewCredit {
  id: string;
  label: string;
  availableCents: number;
  appliedCents: number;
  removed: boolean;
}

export interface ReviewView {
  ticket: TicketRow;
  invoice: {
    id: string;
    type: "NORMAL" | "ESTIMATED";
    subtotalCents: number;
    creditAppliedCents: number;
    totalCents: number;
    cyclesCovered: number;
    lines: { id: string; line_type: string; description: string; quantity: number; rate_cents: number; amount_cents: number }[];
  } | null;
  submission: {
    id: string;
    source: "CUSTOMER" | "OWNER_MANUAL";
    submittedAt: string;
    note: string | null;
    anomaly: "HIGH" | "LOW" | "ZERO" | null;
    attemptNo: number;
    readings: ReviewReading[];
  } | null;
  photo: { url: string | null; capturedAt: string | null; uploadedAt: string } | null;
  credits: ReviewCredit[];
  rolloverToConfirm: boolean;
  rejectionCount: number;
  maxRejections: number;
  /** Engine context for the correction preview (this draft's credits excluded). */
  context: MeterContext | null;
  dueDate: string;
}

const CREDIT_LABEL: Record<string, string> = {
  ADVANCE: "Advance payment",
  OVERPAYMENT: "Overpayment",
  CANCELLED_INVOICE: "Paid on a cancelled invoice",
  ESTIMATE_RECONCILIATION: "Estimate",
  MANUAL: "Credit",
};

export async function getReview(owner: CurrentUser, ticketId: string, ownerClient: Admin): Promise<ReviewView | null> {
  const admin = createAdminClient();
  const t = await loadTicket(admin, ticketId);
  if (!t || t.owner_id !== owner.id) return null;
  const settings = await settingsFor(admin, t.owner_id);
  const dueDate = invoiceDueDate(new Date(), t.due_days);
  const base = { ticket: t, rejectionCount: t.rejection_count, maxRejections: settings.max_meter_rejections, dueDate };
  if (t.status !== "PENDING_OWNER_REVIEW" || !t.current_invoice_id) {
    return { ...base, invoice: null, submission: null, photo: null, credits: [], rolloverToConfirm: false, context: null };
  }

  const [{ data: inv, error: invError }, { data: sub }] = await Promise.all([
    admin
      .from("invoices")
      .select("id, type, subtotal_cents, credit_applied_cents, total_cents, cycles_covered, calculation, lines:invoice_lines!invoice_lines_invoice_fkey(id, line_type, description, quantity, rate_cents, amount_cents, sort_order, credit_id)")
      .eq("id", t.current_invoice_id)
      .single(),
    admin
      .from("meter_submissions")
      .select(
        `id, source, submitted_at, note, anomaly_flag, attempt_no,
         readings:meter_readings!meter_readings_submission_fkey(counter_type, previous_value, current_value, corrected_from_value, correction_note, rolled_over),
         photo:meter_photos!meter_photos_submission_fkey(storage_path, captured_at, uploaded_at, deleted_at)`,
      )
      .eq("ticket_id", t.id)
      .eq("status", "PENDING_REVIEW")
      .maybeSingle(),
  ]);
  if (invError || !inv) throw new Error(`review invoice: ${invError?.message}`);

  const calc = (inv.calculation ?? {}) as { credits?: { id: string; available_cents: number }[]; credits_excluded?: string[] };
  const listed = calc.credits ?? [];
  const excluded = calc.credits_excluded ?? [];
  const ids = [...listed.map((c) => c.id), ...excluded];
  const { data: creditRows } = ids.length ? await admin.from("credits").select("id, kind, amount_cents").in("id", ids) : { data: [] };
  const credits: ReviewCredit[] = [
    ...listed.map((c) => ({ id: c.id, available: c.available_cents, removed: false })),
    ...excluded.map((id) => ({ id, available: creditRows?.find((r) => r.id === id)?.amount_cents ?? 0, removed: true })),
  ].map((c) => ({
    id: c.id,
    label: CREDIT_LABEL[creditRows?.find((r) => r.id === c.id)?.kind ?? "MANUAL"] ?? "Credit",
    availableCents: c.available,
    appliedCents: -inv.lines.filter((l) => l.credit_id === c.id).reduce((sum, l) => sum + l.amount_cents, 0),
    removed: c.removed,
  }));

  const photoRow = sub?.photo && !Array.isArray(sub.photo) ? sub.photo : Array.isArray(sub?.photo) ? sub.photo[0] : null;
  let photo: ReviewView["photo"] = null;
  if (photoRow && !photoRow.deleted_at) {
    // The owner's own client: storage RLS lets an owner read only their tenant's photos.
    const { data: signed } = await ownerClient.storage.from(PHOTO_BUCKET).createSignedUrl(photoRow.storage_path, SIGNED_URL_SECONDS);
    photo = { url: signed?.signedUrl ?? null, capturedAt: photoRow.captured_at, uploadedAt: photoRow.uploaded_at };
  }

  const readings: ReviewReading[] = (sub?.readings ?? [])
    .map((r) => ({
      counter: r.counter_type,
      previous: r.previous_value,
      current: r.current_value,
      correctedFrom: r.corrected_from_value,
      correctionNote: r.correction_note,
      rolledOver: r.rolled_over,
    }))
    .sort((a, b) => a.counter.localeCompare(b.counter));

  return {
    ...base,
    invoice: {
      id: inv.id,
      type: inv.type,
      subtotalCents: inv.subtotal_cents,
      creditAppliedCents: inv.credit_applied_cents,
      totalCents: inv.total_cents,
      cyclesCovered: inv.cycles_covered,
      lines: [...inv.lines].sort((a, b) => a.sort_order - b.sort_order),
    },
    submission: sub
      ? {
          id: sub.id,
          source: sub.source,
          submittedAt: sub.submitted_at,
          note: sub.note,
          anomaly: sub.anomaly_flag as "HIGH" | "LOW" | "ZERO" | null,
          attemptNo: sub.attempt_no,
          readings,
        }
      : null,
    photo,
    credits,
    rolloverToConfirm: readings.some((r) => r.rolledOver),
    context: sub ? await loadMeterContext(admin, t.id, { excludeInvoiceId: inv.id, creditsExcluded: excluded }) : null,
  };
}

async function ownedTicket(owner: CurrentUser, ticketId: string) {
  const admin = createAdminClient();
  const t = await loadTicket(admin, ticketId);
  return t && t.owner_id === owner.id ? { admin, t } : null;
}

async function pendingSubmissionId(admin: Admin, ticketId: string): Promise<string | null> {
  const { data } = await admin.from("meter_submissions").select("id").eq("ticket_id", ticketId).eq("status", "PENDING_REVIEW").maybeSingle();
  return data?.id ?? null;
}

/** Steps 4-5 (INV-07, INV-09, INV-11): issue the invoice; the photo is deleted at once. */
export async function confirmReview(owner: CurrentUser, ticketId: string, rolloverConfirmed: boolean): Promise<ActionResult<{ invoiceNo: string }>> {
  const found = await ownedTicket(owner, ticketId);
  if (!found) return fail("This ticket was not found.");
  const { admin, t } = found;
  try {
    const now = new Date();
    const dueDate = invoiceDueDate(now, t.due_days);
    const [submissionId, { data: brand }, { data: inv }] = await Promise.all([
      pendingSubmissionId(admin, t.id),
      admin
        .from("owner_company_profiles")
        .select("company_name, address, phone, email, logo_path, bank_name, bank_branch, bank_account_name, bank_account_no, letterhead_path, letterhead_layout")
        .eq("owner_id", t.owner_id)
        .maybeSingle(),
      admin.from("invoices").select("total_cents").eq("id", t.current_invoice_id ?? "").maybeSingle(),
    ]);
    const rpc = supabaseRpc(admin);
    const issued = await confirmInvoice(rpc, { kind: "USER", id: owner.id, role: "OWNER" }, t, {
      submissionId,
      dueDate,
      stageDueAt: paymentDeadline(dueDate),
      totalCents: inv?.total_cents ?? 0,
      // BRD-03: issued invoices keep the branding of the day they were issued.
      brandingSnapshot: brand ? { ...brand, snapshot_at: now.toISOString() } : null,
      rolloverConfirmed,
    });
    // Spec 6.5 / INV-09: the photo goes now; the daily job retries anything left behind.
    if (issued.photo_paths.length > 0) {
      const { error: removeError } = await admin.storage.from(PHOTO_BUCKET).remove(issued.photo_paths);
      if (removeError) console.error("[meter review] photo delete:", removeError.message);
      else await rpc("rpc_mark_photos_deleted", { p_ids: issued.photo_ids, p_now: now.toISOString() });
    }
    await onInvoiceIssued({ invoiceId: issued.invoice_id, ticketId: t.id, ownerId: t.owner_id });
    return ok({ invoiceNo: issued.invoice_no });
  } catch (error) {
    return failure(error, "meter confirm");
  }
}

/** INV-07 / 11.3: back to the customer with a reason; the limit hands it to the owner (rule 28). */
export async function rejectReview(owner: CurrentUser, ticketId: string, reason: string): Promise<ActionResult<{ final: boolean }>> {
  const found = await ownedTicket(owner, ticketId);
  if (!found) return fail("This ticket was not found.");
  const { admin, t } = found;
  try {
    const now = new Date();
    const settings = await settingsFor(admin, t.owner_id);
    const submissionId = await pendingSubmissionId(admin, t.id);
    // An estimate is not counted as a rejection of the customer.
    const final = submissionId !== null && t.rejection_count + 1 >= settings.max_meter_rejections;
    await rejectReading(supabaseRpc(admin), { kind: "USER", id: owner.id, role: "OWNER" }, t, {
      submissionId,
      reason,
      stageDueAt: meterDeadline(now, settings),
      photoExpiresAt: rejectedPhotoExpiry(now, settings),
      final,
    });
    return ok({ final });
  } catch (error) {
    return failure(error, "meter reject");
  }
}

/** INV-08: corrected reading, recalculated by the engine with the same credits; customer told. */
export async function correctReview(
  owner: CurrentUser,
  ticketId: string,
  typed: { bw: string; colour: string },
  note: string,
): Promise<ActionResult & { fieldErrors?: ReadingErrors }> {
  const found = await ownedTicket(owner, ticketId);
  if (!found) return fail("This ticket was not found.");
  const { admin, t } = found;
  try {
    if (!note.trim()) return fail("Write a note explaining the correction.", { note: "A note is required" });
    const { data: sub } = await admin
      .from("meter_submissions")
      .select("id, source, invoice_id, readings:meter_readings!meter_readings_submission_fkey(counter_type, current_value)")
      .eq("ticket_id", t.id)
      .eq("status", "PENDING_REVIEW")
      .maybeSingle();
    if (!sub || !sub.invoice_id) return fail("There is no reading waiting for review.");
    const { data: inv } = await admin.from("invoices").select("calculation").eq("id", sub.invoice_id).single();
    const excluded = ((inv?.calculation ?? {}) as { credits_excluded?: string[] }).credits_excluded ?? [];
    const context = await loadMeterContext(admin, t.id, { excludeInvoiceId: sub.invoice_id, creditsExcluded: excluded });
    const preview = previewReading(context, typed);
    if (!preview.ok) return { ...fail(preview.message ?? "Please check the reading."), fieldErrors: preview.errors };
    const changes = preview.counters
      .map((c) => ({ c, old: sub.readings.find((r) => r.counter_type === c.counter)?.current_value }))
      .filter(({ c, old }) => old !== undefined && old !== c.current)
      .map(({ c, old }) => describeChange(c.counter, old!, c.current));
    if (changes.length === 0) return fail("The reading is the same as before.");
    const s = preview.submission;
    await correctReading(supabaseRpc(admin), { kind: "USER", id: owner.id, role: "OWNER" }, t, {
      submissionId: sub.id,
      readings: s.readings,
      invoice: s.invoice,
      anomalyFlag: s.anomalyFlag,
      note,
      changes: changes.join(", "),
    });
    return ok(undefined);
  } catch (error) {
    return failure(error, "meter correct");
  }
}

export const manualEntrySchema = z.object({
  ticketId: z.uuid(),
  idempotencyKey: z.uuid(),
  bw: z.string().max(20),
  colour: z.string().max(20).default(""),
  note: z.string().trim().min(1, "Write why you are entering the reading").max(1000),
});

/** INV-12: the owner types the reading (no photo), with a reason; same engine; customer told. */
export async function enterReadingForCustomer(
  owner: CurrentUser,
  input: z.input<typeof manualEntrySchema>,
): Promise<ActionResult & { fieldErrors?: Record<string, string> }> {
  const parsed = manualEntrySchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, { note: parsed.error.issues[0].message });
  const i = parsed.data;
  const found = await ownedTicket(owner, i.ticketId);
  if (!found) return fail("This ticket was not found.");
  const { admin, t } = found;
  try {
    const context = await loadMeterContext(admin, t.id);
    const preview = previewReading(context, { bw: i.bw, colour: i.colour });
    if (!preview.ok) return { ...fail(preview.message ?? "Please check the reading."), fieldErrors: preview.errors };
    const settings = await settingsFor(admin, t.owner_id);
    const s = preview.submission;
    await enterReadingManually(supabaseRpc(admin), { kind: "USER", id: owner.id, role: "OWNER" }, t, {
      idempotencyKey: i.idempotencyKey,
      readings: s.readings,
      invoice: s.invoice,
      anomalyFlag: s.anomalyFlag,
      note: i.note,
      stageDueAt: reviewDeadline(new Date(), settings),
    });
    return ok(undefined);
  } catch (error) {
    return failure(error, "meter manual entry");
  }
}

/** The owner's manual entry form: previous readings and the engine context. */
export async function getManualEntry(owner: CurrentUser, ticketId: string) {
  const found = await ownedTicket(owner, ticketId);
  if (!found) return null;
  const { admin, t } = found;
  const meter = isMeterStage({ status: t.status, statusBeforeOverdue: t.status_before_overdue });
  const context = meter ? await loadMeterContext(admin, t.id) : null;
  return { ticket: t, context, previous: context ? previousValues(context) : null, allowed: meter };
}
