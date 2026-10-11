import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { isIsoDate, todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import { creditOnIssuedInvoice } from "@/lib/billing/dispute";
import { BillingError } from "@/lib/billing/errors";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { onInvoiceChanged } from "@/lib/invoices/issued";
import { parseTyped } from "@/lib/meter/readings";
import { checkMeterPhotoFile, PHOTO_BUCKET } from "@/lib/meter/service";
import { rupeesToCents } from "@/lib/money";
import { checkSlipFile, SLIP_EXTENSION } from "@/lib/payments/slip-check";
import { createAdminClient } from "@/lib/supabase/admin";
import { englishOnly } from "@/lib/text/english";
import { paymentDeadline } from "@/lib/tickets/deadlines";
import type { TicketStatus } from "@/lib/tickets/states";
import {
  type Actor,
  creditDispute,
  raiseDispute,
  rejectDispute,
  requestDisputePhoto,
  RpcError,
  sendDisputePhoto,
  type TicketSnapshot,
  TransitionError,
} from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

/**
 * Disputes (spec 11.4, CP-06; decisions 47-49). The customer disputes an issued
 * bill once, with a reason and an optional photo or PDF (same checks as payment
 * slips, its own private bucket). The owner rejects it (optional new due date),
 * corrects the invoice (src/lib/invoices/correction.ts) or gives a credit, and may
 * ask for a fresh live meter photo first. Every change goes through a transition
 * function and its atomic rpc; ownership is checked here first, so another
 * tenant's ticket looks like a missing one.
 */

type Admin = SupabaseClient<Database>;

export const DISPUTE_BUCKET = "dispute-files";
const SIGNED_URL_SECONDS = 5 * 60;

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof TransitionError) return fail(error.message.replace(/^[^:]+: /, ""));
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, context));
  if (error instanceof BillingError) return fail(error.message);
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again.");
}

const actorOf = (user: CurrentUser): Actor => ({ kind: "USER", id: user.id, role: user.role });

interface DisputeTicket extends TicketSnapshot {
  machine_type: "MONO" | "COLOUR";
  invoice: { id: string; invoice_no: string | null; status: string; due_date: string | null; total_cents: number; amount_paid_cents: number; credit_applied_cents: number } | null;
}

async function loadTicket(admin: Admin, ticketId: string): Promise<DisputeTicket | null> {
  const { data, error } = await admin
    .from("billing_cycle_tickets")
    .select(
      `id, owner_id, customer_id, cycle_no, status, status_before_overdue, machine_type,
       machine:machines!billing_cycle_tickets_machine_fkey(brand, model), customer:customers!billing_cycle_tickets_customer_fkey(name),
       invoice:invoices!billing_cycle_tickets_current_invoice_fkey(id, invoice_no, status, due_date, total_cents, amount_paid_cents, credit_applied_cents)`,
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw new Error(`dispute ticket: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    owner_id: data.owner_id,
    customer_id: data.customer_id,
    cycle_no: data.cycle_no,
    status: data.status as TicketStatus,
    status_before_overdue: data.status_before_overdue as TicketStatus | null,
    machine_type: data.machine_type,
    machine_name: `${data.machine.brand} ${data.machine.model}`,
    customer_name: data.customer.name,
    invoice: data.invoice,
  };
}

// -----------------------------------------------------------------------------
// What both sides see
// -----------------------------------------------------------------------------

export interface DisputeView {
  id: string;
  status: "OPEN" | "RESOLVED" | "REJECTED";
  kind: "REJECTED" | "CORRECTED" | "CREDIT" | "CANCELLED" | null;
  reason: string;
  resolution: string | null;
  raisedAt: string;
  resolvedAt: string | null;
  newDueDate: string | null;
  invoiceNo: string | null;
  credit: { amountCents: number } | null;
  replacement: { id: string; invoiceNo: string | null } | null;
  attachment: { url: string | null; mime: string } | null;
  photo: { requestedAt: string; note: string | null; receivedAt: string | null; readings: { counter_type: "BW" | "COLOUR"; value: number }[] | null; url: string | null } | null;
}

/**
 * The ticket's latest dispute, with signed links to its file and fresh photo. Runs
 * with the signed-in user's client: RLS and the storage policies decide (the photo
 * file is readable by the owner only).
 */
export async function getTicketDispute(client: Admin, ticketId: string): Promise<DisputeView | null> {
  const { data, error } = await client
    .from("disputes")
    .select(
      `id, status, resolution_kind, reason, resolution, created_at, resolved_at, new_due_date, attachment_path, attachment_mime,
       photo_requested_at, photo_request_note, photo_received_at, photo_readings,
       invoice:invoices!disputes_invoice_fkey(invoice_no),
       credit:credits!disputes_credit_id_fkey(amount_cents),
       replacement:invoices!disputes_replacement_fkey(id, invoice_no)`,
    )
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`dispute: ${error.message}`);
  if (!data) return null;

  const [attachment, photoRow] = await Promise.all([
    data.attachment_path ? client.storage.from(DISPUTE_BUCKET).createSignedUrl(data.attachment_path, SIGNED_URL_SECONDS) : null,
    data.photo_received_at
      ? client.from("meter_photos").select("storage_path, deleted_at").eq("dispute_id", data.id).is("deleted_at", null).order("uploaded_at", { ascending: false }).limit(1).maybeSingle()
      : null,
  ]);
  const photoPath = photoRow?.data?.storage_path ?? null;
  const photoUrl = photoPath ? (await client.storage.from(PHOTO_BUCKET).createSignedUrl(photoPath, SIGNED_URL_SECONDS)).data?.signedUrl ?? null : null;

  return {
    id: data.id,
    status: data.status,
    kind: data.resolution_kind,
    reason: data.reason,
    resolution: data.resolution,
    raisedAt: data.created_at,
    resolvedAt: data.resolved_at,
    newDueDate: data.new_due_date,
    invoiceNo: data.invoice?.invoice_no ?? null,
    credit: data.credit ? { amountCents: data.credit.amount_cents } : null,
    replacement: data.replacement ? { id: data.replacement.id, invoiceNo: data.replacement.invoice_no } : null,
    attachment: data.attachment_path ? { url: attachment?.data?.signedUrl ?? null, mime: data.attachment_mime ?? "" } : null,
    photo: data.photo_requested_at
      ? {
          requestedAt: data.photo_requested_at,
          note: data.photo_request_note,
          receivedAt: data.photo_received_at,
          readings: (data.photo_readings as { counter_type: "BW" | "COLOUR"; value: number }[] | null) ?? null,
          url: photoUrl,
        }
      : null,
  };
}

// -----------------------------------------------------------------------------
// Customer: dispute a bill, send the fresh photo
// -----------------------------------------------------------------------------

const reasonField = z
  .string()
  .trim()
  .min(3, "Tell your rental company what is wrong with the bill.")
  .max(1000, "At most 1,000 characters.")
  .refine(...englishOnly);

export const disputeInputSchema = z.object({
  invoiceId: z.uuid(),
  idempotencyKey: z.uuid(),
  reason: reasonField,
  filePath: z.string().max(300).nullable().default(null),
});
export type DisputeInput = z.input<typeof disputeInputSchema>;

/** The bill the customer may dispute, or why not (the page shows the form or the reason). */
export async function getDisputeForm(user: CurrentUser, invoiceId: string) {
  const admin = createAdminClient();
  const { data: inv } = await admin.from("invoices").select("id, ticket_id, customer_id, owner_id, invoice_no, status, total_cents, amount_paid_cents").eq("id", invoiceId).maybeSingle();
  if (!inv || inv.customer_id !== user.id || !inv.invoice_no) return null;
  const t = await loadTicket(admin, inv.ticket_id);
  if (!t) return null;
  const { count } = await admin.from("disputes").select("id", { count: "exact", head: true }).eq("invoice_id", inv.id);
  const current = t.invoice?.id === inv.id;
  const blocked =
    (count ?? 0) > 0
      ? "You already disputed this bill. You can still write to your rental company in the ticket's messages."
      : !current || !["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"].includes(inv.status)
        ? inv.status === "PAYMENT_SUBMITTED"
          ? "A payment slip for this bill is being checked. Write to your rental company in the ticket's messages."
          : "This bill cannot be disputed now."
        : null;
  return { invoice: inv, ticketId: t.id, ownerId: t.owner_id, machine: t.machine_name ?? "", blocked };
}

export async function raiseCustomerDispute(user: CurrentUser, input: DisputeInput): Promise<ActionResult<{ ticketId: string; replayed: boolean }>> {
  const parsed = disputeInputSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, { reason: parsed.error.issues[0].message });
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const { data: earlier } = await admin.from("disputes").select("ticket_id, customer_id").eq("idempotency_key", i.idempotencyKey).maybeSingle();
    if (earlier) return earlier.customer_id === user.id ? ok({ ticketId: earlier.ticket_id, replayed: true }) : fail("Please reload the page and try again.");

    const form = await getDisputeForm(user, i.invoiceId);
    if (!form) return fail("This bill was not found.");
    if (form.blocked) return fail(form.blocked);
    const t = await loadTicket(admin, form.ticketId);
    if (!t) return fail("This bill was not found.");

    // The optional photo or PDF: in the customer's folder, checked on the stored bytes (decision 41).
    let attachment: Parameters<typeof raiseDispute>[3]["attachment"] = null;
    if (i.filePath) {
      const folder = new RegExp(`^${t.owner_id}/${user.id}/[0-9a-f-]{36}\\.(jpg|png|pdf)$`);
      if (!folder.test(i.filePath)) return fail("The file upload did not work. Please add it again.", { file: "Please add the file again." });
      const { data: file, error: downloadError } = await admin.storage.from(DISPUTE_BUCKET).download(i.filePath);
      if (downloadError || !file) return fail("The file did not arrive. Please add it again.", { file: "Please add the file again." });
      const checked = await checkSlipFile(new Uint8Array(await file.arrayBuffer()));
      if (!checked.ok || !i.filePath.endsWith(`.${SLIP_EXTENSION[checked.mimeType]}`)) {
        await admin.storage.from(DISPUTE_BUCKET).remove([i.filePath]);
        const message = checked.ok ? "The file type does not match its name. Please add it again." : checked.error;
        return fail(message, { file: message });
      }
      attachment = { storagePath: i.filePath, sha256: checked.sha256, mimeType: checked.mimeType, sizeBytes: checked.sizeBytes };
    }

    const r = await raiseDispute(supabaseRpc(admin), actorOf(user), t, {
      idempotencyKey: i.idempotencyKey,
      reason: i.reason,
      attachment,
      context: { invoiceNo: form.invoice.invoice_no },
    });
    return ok({ ticketId: t.id, replayed: r.replayed });
  } catch (error) {
    return failure(error, "dispute raise");
  }
}

export const disputePhotoSchema = z.object({
  ticketId: z.uuid(),
  photoPath: z.string().min(1).max(300),
  capturedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  bw: z.string().max(20),
  colour: z.string().max(20).default(""),
});

/** The fresh live meter photo the owner asked for, with the reading(s) it shows. */
export async function sendCustomerDisputePhoto(user: CurrentUser, input: z.input<typeof disputePhotoSchema>): Promise<ActionResult & { fieldErrors?: Record<string, string> }> {
  const parsed = disputePhotoSchema.safeParse(input);
  if (!parsed.success) return fail("Please check the photo and the reading.");
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const t = await loadTicket(admin, i.ticketId);
    if (!t || t.customer_id !== user.id) return fail("This ticket was not found.");
    const typed = parseTyped(t.machine_type, { bw: i.bw, colour: i.colour });
    if (!typed.ok) return { ...fail("Please check the reading."), fieldErrors: typed.errors };
    const problem = await checkMeterPhotoFile(admin, t, i.photoPath);
    if (problem) return fail(problem);
    await sendDisputePhoto(supabaseRpc(admin), actorOf(user), t, {
      storagePath: i.photoPath,
      capturedAt: i.capturedAt ? new Date(i.capturedAt) : undefined,
      readings: [
        { counter_type: "BW" as const, value: typed.readings.BW },
        ...(typed.readings.COLOUR !== null ? [{ counter_type: "COLOUR" as const, value: typed.readings.COLOUR }] : []),
      ],
    });
    return ok(undefined);
  } catch (error) {
    return failure(error, "dispute photo");
  }
}

/** The customer's fresh-photo page: the open request, or null. */
export async function getDisputePhotoRequest(user: CurrentUser, ticketId: string) {
  const admin = createAdminClient();
  const t = await loadTicket(admin, ticketId);
  if (!t || t.customer_id !== user.id) return null;
  const { data: d } = await admin
    .from("disputes")
    .select("id, photo_requested_at, photo_request_note, photo_received_at")
    .eq("ticket_id", t.id)
    .eq("status", "OPEN")
    .maybeSingle();
  const open = t.status === "DISPUTED" && d?.photo_requested_at && !d.photo_received_at;
  return { ticketId: t.id, ownerId: t.owner_id, machine: t.machine_name ?? "", machineType: t.machine_type, note: d?.photo_request_note ?? null, open: Boolean(open) };
}

// -----------------------------------------------------------------------------
// Owner: reject, give a credit, ask for a fresh photo
// -----------------------------------------------------------------------------

export type OwnerDisputeAction =
  | { action: "reject"; reason: string; dueDate?: string | null }
  | { action: "credit"; reason: string; amount: string }
  | { action: "requestPhoto"; note?: string };

/** Deletes the dispute's fresh photo files the database marked when the dispute ended (the daily job retries). */
async function purgeDisputePhotos(admin: Admin, ticketId: string) {
  const { data: dispute } = await admin.from("disputes").select("id").eq("ticket_id", ticketId).neq("status", "OPEN").order("resolved_at", { ascending: false }).limit(1).maybeSingle();
  if (!dispute) return;
  const { data: photos } = await admin.from("meter_photos").select("id, storage_path").eq("dispute_id", dispute.id).is("deleted_at", null).not("delete_requested_at", "is", null);
  if (!photos?.length) return;
  const { error } = await admin.storage.from(PHOTO_BUCKET).remove(photos.map((p) => p.storage_path));
  if (error) return console.error("[dispute] photo delete:", error.message);
  await supabaseRpc(admin)("rpc_mark_photos_deleted", { p_ids: photos.map((p) => p.id), p_now: new Date().toISOString() });
}

export async function ownerDisputeAction(owner: CurrentUser, ticketId: string, input: OwnerDisputeAction): Promise<ActionResult<{ status?: string }>> {
  const admin = createAdminClient();
  try {
    const t = await loadTicket(admin, ticketId);
    if (!t || t.owner_id !== owner.id) return fail("This ticket was not found.");
    const rpc = supabaseRpc(admin);
    const actor = actorOf(owner);
    const inv = t.invoice;
    switch (input.action) {
      case "reject": {
        const dueDate = input.dueDate?.trim() || null;
        if (dueDate && (!isIsoDate(dueDate) || dueDate < todayInColombo())) return fail("Choose a due date from today.", { dueDate: "From today on." });
        const stageDue = dueDate ?? inv?.due_date ?? todayInColombo();
        await rejectDispute(rpc, actor, t, {
          reason: input.reason,
          dueDate,
          stageDueAt: paymentDeadline(stageDue),
          context: { invoiceNo: inv?.invoice_no ?? null, dueDate: inv?.due_date ?? null },
        });
        if (dueDate) await onInvoiceChanged(inv?.id);
        await purgeDisputePhotos(admin, t.id);
        return ok({ status: "AWAITING_PAYMENT" });
      }
      case "credit": {
        if (!inv?.due_date) return fail("This ticket has no bill.");
        const cents = rupeesToCents(input.amount);
        if (!cents) return fail("Enter the credit in rupees, for example 1500.", { amount: "Enter an amount in rupees." });
        const creditId = crypto.randomUUID();
        const c = creditOnIssuedInvoice({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents, creditAppliedCents: inv.credit_applied_cents }, creditId, cents);
        const r = await creditDispute(rpc, actor, t, {
          reason: input.reason,
          creditId,
          amountCents: cents,
          line: c.line,
          totalCents: c.totalCents,
          leftOverCents: c.leftOverCents,
          stageDueAt: paymentDeadline(inv.due_date),
          context: { invoiceNo: inv.invoice_no },
        });
        await onInvoiceChanged(inv.id);
        await purgeDisputePhotos(admin, t.id);
        return ok({ status: r.status });
      }
      case "requestPhoto":
        await requestDisputePhoto(rpc, actor, t, { note: input.note ?? "" });
        return ok({});
    }
  } catch (error) {
    return failure(error, `dispute ${input.action}`);
  }
}

/** After a correction from a dispute (correction.ts): delete the dispute's fresh photo now. */
export async function afterDisputeCorrected(ticketId: string) {
  await purgeDisputePhotos(createAdminClient(), ticketId);
}
