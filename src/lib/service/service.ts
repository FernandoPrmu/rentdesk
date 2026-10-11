import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type ActionResult, fail, fieldErrorsFrom, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { supabaseRpc } from "@/lib/cron/server";
import { classifyDisputeError, OWNER_RETRY_MESSAGE, TransientError } from "@/lib/disputes/errors";
import { checkSlipFile } from "@/lib/payments/slip-check";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

import { tonerColoursFor } from "./rules";
import { assignSchema, noteSchema, raiseSchema, type RaiseInput, rateSchema, reasonSchema, resolveSchema } from "./schemas";
import type { ServiceStatus, ServiceType, TonerColour, Urgency } from "./states";
import { raiseRequest, rateRequest, type RequestSnapshot, serviceStep, type StepInput } from "./transitions";

/**
 * Service requests on the server (SRV-01..09, CP-07; decisions 57-62). Inputs are
 * checked with Zod, ownership here first (another tenant's request looks like a
 * missing one), then the transition functions call the atomic rpc. Failures the
 * database did not refuse (a statement timeout when the free tier stalls, a
 * dropped connection) get a retry message: the request carries an idempotency key,
 * and every other step re-checks the status (decision 47's pattern).
 */

type Admin = SupabaseClient<Database>;

export const SERVICE_BUCKET = "service-photos";
export const RAISE_RETRY_MESSAGE = "We could not confirm that your request was sent (the connection was slow). Tap Send again: it is never sent twice.";
const CUSTOMER_RETRY_MESSAGE = "The connection was too slow to confirm this. Reload the page to see whether it was saved, then try again if needed.";

function failure(error: unknown, context: string, retryMessage = OWNER_RETRY_MESSAGE): { ok: false; error: string } {
  const f = classifyDisputeError(error, retryMessage);
  if (f.kind === "TRANSIENT") console.error(`[${context}] transient:`, error instanceof Error ? `${error.name}: ${error.message}` : error);
  return fail(f.message);
}

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new TransientError(`${what}: ${result.error.message}`);
  return result.data;
}

const actorOf = (user: CurrentUser): Actor => ({ kind: "USER", id: user.id, role: user.role });

/** The request as the step functions need it (service role; the caller checks the tenant). */
async function loadSnapshot(admin: Admin, id: string): Promise<RequestSnapshot | null> {
  const r = check(
    await admin
      .from("service_requests")
      .select(
        "id, owner_id, customer_id, status, type, urgency, toner_colours, machine:machines!service_requests_machine_fkey(brand, model, serial_no), customer:customers!service_requests_customer_fkey(name)",
      )
      .eq("id", id)
      .maybeSingle(),
    "service request",
  );
  if (!r) return null;
  return {
    id: r.id,
    owner_id: r.owner_id,
    customer_id: r.customer_id,
    status: r.status as ServiceStatus,
    type: r.type as ServiceType,
    urgency: r.urgency as Urgency,
    toner_colours: r.toner_colours as TonerColour[],
    machine_name: `${r.machine.brand} ${r.machine.model} (${r.machine.serial_no})`,
    customer_name: r.customer.name,
  };
}

// -----------------------------------------------------------------------------
// Customer: raise a request
// -----------------------------------------------------------------------------

export interface RentedMachine {
  id: string;
  name: string;
  serialNo: string;
  type: "MONO" | "COLOUR";
  location: string | null;
}

/** The machines the customer rents now (the form's choices), with the owner to tell. */
export async function getRaiseForm(user: CurrentUser): Promise<{ ownerId: string; machines: RentedMachine[] }> {
  const admin = createAdminClient();
  const rows = check(
    await admin
      .from("rental_agreements")
      .select("machine:machines!rental_agreements_machine_fkey(id, brand, model, serial_no, type), installation_location")
      .eq("customer_id", user.id)
      .neq("status", "TERMINATED")
      .order("created_at"),
    "rented machines",
  );
  return {
    ownerId: user.owner_id ?? "",
    machines: (rows ?? []).map((a) => ({
      id: a.machine.id,
      name: `${a.machine.brand} ${a.machine.model}`,
      serialNo: a.machine.serial_no,
      type: a.machine.type,
      location: a.installation_location,
    })),
  };
}

export async function raiseServiceRequest(user: CurrentUser, input: RaiseInput): Promise<ActionResult<{ requestId: string; replayed: boolean }>> {
  const parsed = raiseSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  if (user.role !== "CUSTOMER" || !user.owner_id) return fail("Only a customer raises a service request.");
  const admin = createAdminClient();
  try {
    // A retry of a request that went through (its response was lost) returns it.
    const earlier = check(await admin.from("service_requests").select("id, created_by").eq("idempotency_key", i.idempotencyKey).maybeSingle(), "request replay");
    if (earlier) return earlier.created_by === user.id ? ok({ requestId: earlier.id, replayed: true }) : fail("Please reload the page and try again.");

    const form = await getRaiseForm(user);
    const machine = form.machines.find((m) => m.id === i.machineId);
    if (!machine) return fail("Choose one of your machines.", { machineId: "Choose one of your machines." });
    const colours = tonerColoursFor(i.type, machine.type, i.tonerColours);
    if (!colours.ok) return fail(colours.error, { tonerColours: colours.error });
    if (i.partName && i.type !== "SPARE_PART") return fail("A part name is only for spare part requests.", { partName: "Only for spare parts." });

    // The optional photo: in the customer's folder, checked on the stored bytes (decision 58).
    let photo: Parameters<typeof raiseRequest>[2]["photo"] = null;
    if (i.photoPath) {
      const folder = new RegExp(`^${user.owner_id}/${user.id}/[0-9a-f-]{36}\\.(jpg|png)$`);
      if (!folder.test(i.photoPath)) return fail("The photo upload did not work. Please add it again.", { photo: "Please add the photo again." });
      const { data: file, error: downloadError } = await admin.storage.from(SERVICE_BUCKET).download(i.photoPath);
      if (downloadError || !file) {
        const status = (downloadError as { status?: number; statusCode?: string | number } | null)?.status ?? Number((downloadError as { statusCode?: string } | null)?.statusCode);
        if (status === 400 || status === 404 || !downloadError) return fail("The photo did not arrive. Please add it again.", { photo: "Please add the photo again." });
        throw new TransientError(`service photo download: ${downloadError.message}`);
      }
      const checked = await checkSlipFile(new Uint8Array(await file.arrayBuffer()));
      const extension = checked.ok ? (checked.mimeType === "image/png" ? "png" : checked.mimeType === "image/jpeg" ? "jpg" : null) : null;
      if (!checked.ok || checked.mimeType === "application/pdf" || !extension || !i.photoPath.endsWith(`.${extension}`)) {
        await admin.storage.from(SERVICE_BUCKET).remove([i.photoPath]);
        const message = checked.ok ? "Please add a photo (JPG or PNG)." : checked.error;
        return fail(message, { photo: message });
      }
      photo = { storagePath: i.photoPath, sha256: checked.sha256, mimeType: checked.mimeType as "image/jpeg" | "image/png", sizeBytes: checked.sizeBytes };
    }

    const customer = check(await admin.from("customers").select("name").eq("id", user.id).single(), "customer");
    const r = await raiseRequest(supabaseRpc(admin), actorOf(user), {
      idempotencyKey: i.idempotencyKey,
      machineId: machine.id,
      ownerId: user.owner_id,
      type: i.type,
      urgency: i.urgency,
      description: i.description,
      tonerColours: colours.colours,
      partName: i.partName ?? null,
      preferredDate: i.preferredDate ?? null,
      photo,
      context: { machine: `${machine.name} (${machine.serialNo})`, customer: customer?.name ?? user.full_name },
    });
    return ok({ requestId: r.request_id, replayed: r.replayed });
  } catch (error) {
    return failure(error, "service raise", RAISE_RETRY_MESSAGE);
  }
}

// -----------------------------------------------------------------------------
// Owner and customer steps
// -----------------------------------------------------------------------------

/** What the owner's forms send (strings from inputs; parsed here). */
export type OwnerStepForm =
  | { action: "ACKNOWLEDGE" | "START" | "CLOSE"; note?: string }
  | { action: "ASSIGN"; technician: string; plannedDate?: string; note?: string }
  | {
      action: "RESOLVE";
      workDone: string;
      partsUsed?: string;
      cost?: string;
      chargeAmount?: string;
      chargeDescription?: string;
      discountAmount?: string;
      discountDescription?: string;
      note?: string;
    }
  | { action: "CANCEL"; reason: string }
  | { action: "NOTE"; note: string };

function ownerStep(form: OwnerStepForm): { ok: true; step: StepInput } | { ok: false; error: string; fieldErrors?: Record<string, string> } {
  const issue = (r: { error: { issues: { path: PropertyKey[]; message: string }[] } }) => ({
    ok: false as const,
    error: r.error.issues[0].message,
    fieldErrors: fieldErrorsFrom(r.error.issues),
  });
  switch (form.action) {
    case "ASSIGN": {
      const r = assignSchema.safeParse(form);
      if (!r.success) return issue(r);
      return { ok: true, step: { action: "ASSIGN", technician: r.data.technician, plannedDate: r.data.plannedDate ?? null, note: r.data.note } };
    }
    case "RESOLVE": {
      const r = resolveSchema.safeParse(form);
      if (!r.success) return issue(r);
      const d = r.data;
      return {
        ok: true,
        step: {
          action: "RESOLVE",
          workDone: d.workDone,
          partsUsed: d.partsUsed ?? null,
          costCents: d.cost,
          charge: d.chargeAmount !== null && d.chargeDescription ? { amountCents: d.chargeAmount, description: d.chargeDescription } : null,
          discount: d.discountAmount !== null && d.discountDescription ? { amountCents: d.discountAmount, description: d.discountDescription } : null,
          note: d.note,
        },
      };
    }
    case "CANCEL": {
      const r = reasonSchema.safeParse(form.reason);
      if (!r.success) return { ok: false, error: r.error.issues[0].message, fieldErrors: { reason: r.error.issues[0].message } };
      return { ok: true, step: { action: "CANCEL", reason: r.data } };
    }
    case "NOTE": {
      const r = noteSchema.safeParse(form.note);
      if (!r.success || !r.data) return { ok: false, error: r.success ? "Write the note." : r.error.issues[0].message, fieldErrors: { note: "Write the note." } };
      return { ok: true, step: { action: "NOTE", note: r.data } };
    }
    default: {
      const r = noteSchema.safeParse(form.note);
      if (!r.success) return { ok: false, error: r.error.issues[0].message, fieldErrors: { note: r.error.issues[0].message } };
      return { ok: true, step: { action: form.action, note: r.data } };
    }
  }
}

export async function ownerServiceAction(user: CurrentUser, requestId: string, form: OwnerStepForm): Promise<ActionResult<{ status: ServiceStatus }>> {
  const step = ownerStep(form);
  if (!step.ok) return fail(step.error, step.fieldErrors);
  const admin = createAdminClient();
  try {
    const r = await loadSnapshot(admin, requestId);
    if (!r || r.owner_id !== user.id) return fail("This request was not found.");
    const result = await serviceStep(supabaseRpc(admin), actorOf(user), r, step.step);
    return ok({ status: result.status });
  } catch (error) {
    return failure(error, `service ${form.action.toLowerCase()}`);
  }
}

export type CustomerStepForm = { action: "CONFIRM" } | { action: "REOPEN"; reason: string } | { action: "CANCEL"; reason: string };

export async function customerServiceAction(user: CurrentUser, requestId: string, form: CustomerStepForm): Promise<ActionResult<{ status: ServiceStatus }>> {
  let step: StepInput;
  if (form.action === "CONFIRM") step = { action: "CONFIRM" };
  else {
    const reason = reasonSchema.safeParse(form.reason);
    if (!reason.success) {
      const message = form.action === "REOPEN" ? "Tell your rental company what is still wrong." : reason.error.issues[0].message;
      return fail(message, { reason: message });
    }
    step = { action: form.action, reason: reason.data };
  }
  const admin = createAdminClient();
  try {
    const r = await loadSnapshot(admin, requestId);
    if (!r || r.customer_id !== user.id) return fail("This request was not found.");
    const result = await serviceStep(supabaseRpc(admin), actorOf(user), r, step);
    return ok({ status: result.status });
  } catch (error) {
    return failure(error, `service ${form.action.toLowerCase()}`, CUSTOMER_RETRY_MESSAGE);
  }
}

export async function rateService(user: CurrentUser, requestId: string, input: { rating: number; comment?: string }): Promise<ActionResult> {
  const parsed = rateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, fieldErrorsFrom(parsed.error.issues));
  const admin = createAdminClient();
  try {
    const r = await loadSnapshot(admin, requestId);
    if (!r || r.customer_id !== user.id) return fail("This request was not found.");
    await rateRequest(supabaseRpc(admin), actorOf(user), r, { rating: parsed.data.rating, comment: parsed.data.comment ?? null });
    return ok(undefined);
  } catch (error) {
    return failure(error, "service rate", CUSTOMER_RETRY_MESSAGE);
  }
}
