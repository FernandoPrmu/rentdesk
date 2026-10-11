import { z } from "zod";

import { formatRupees } from "../money.ts";
import { customer, type NotificationContext, type NotificationEvent, owner, serviceNotifications } from "../notifications/service.ts";
import { type Actor, type Rpc, TransitionError } from "../tickets/transitions.ts";
import {
  COLOUR_LABEL,
  type ServiceAction,
  type ServiceRole,
  serviceRefusal,
  type ServiceStatus,
  type ServiceType,
  type TonerColour,
  TYPE_LABEL,
  type Urgency,
} from "./states.ts";

/**
 * One function per service request step (SRV-03..05, SRV-07, SRV-09; decision 57).
 * Each validates its input, checks the actor's role, tenant and the request's
 * status (states.ts), builds the notification for the other side (SRV-05), and
 * only then calls the atomic rpc, which locks the request, checks everything again
 * and writes the status trail, the audit entry and the notifications in one
 * transaction. Only relative imports: DB tests drive the same code under Node.
 */

/** What the step functions need to know about a request (loaded by the caller). */
export interface RequestSnapshot {
  id: string;
  owner_id: string;
  customer_id: string;
  status: ServiceStatus;
  type: ServiceType;
  urgency: Urgency;
  toner_colours: TonerColour[];
  machine_name: string;
  customer_name: string;
}

/** "Toner (cyan, magenta)". */
export function requestLabel(r: Pick<RequestSnapshot, "type" | "toner_colours">): string {
  const colours = r.type === "TONER" && r.toner_colours.length > 0 ? ` (${r.toner_colours.map((c) => COLOUR_LABEL[c].toLowerCase()).join(", ")})` : "";
  return `${TYPE_LABEL[r.type]}${colours}`;
}

function context(r: RequestSnapshot, extra: NotificationContext = {}): NotificationContext {
  return { machine: r.machine_name, customer: r.customer_name, urgency: r.urgency, request: requestLabel(r), ...extra };
}

/** The start of a note for the notification body. */
export function preview(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}

function roleOf(actor: Actor): ServiceRole {
  if (actor.kind !== "USER" || (actor.role !== "OWNER" && actor.role !== "CUSTOMER")) {
    throw new TransitionError("FORBIDDEN", "Only the customer and the rental company act on a request");
  }
  return actor.role;
}

function assertStep(action: ServiceAction, actor: Actor, r: RequestSnapshot): ServiceRole {
  const role = roleOf(actor);
  const id = actor.kind === "USER" ? actor.id : null;
  if (role === "OWNER" && id !== r.owner_id) throw new TransitionError("FORBIDDEN", "This request belongs to another owner");
  if (role === "CUSTOMER" && id !== r.customer_id) throw new TransitionError("FORBIDDEN", "This request belongs to another customer");
  const refusal = serviceRefusal(action, role, r.status);
  if (refusal) throw new TransitionError("INVALID_STATE", refusal);
  return role;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TransitionError("INVALID_INPUT", result.error.issues[0]?.message ?? "Invalid input");
  return result.data;
}

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.object({ amountCents: z.number().int().positive(), description: z.string().trim().min(1).max(200) });

// -----------------------------------------------------------------------------
// Raise (customer)
// -----------------------------------------------------------------------------

const raiseInput = z.object({
  idempotencyKey: z.uuid(),
  machineId: z.uuid(),
  ownerId: z.uuid(),
  type: z.enum(["BREAKDOWN", "TONER", "SPARE_PART", "MAINTENANCE", "OTHER"]),
  urgency: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  description: text(1000).min(1),
  tonerColours: z.array(z.enum(["BLACK", "CYAN", "MAGENTA", "YELLOW"])),
  partName: text(100).nullable().default(null),
  preferredDate: isoDate.nullable().default(null),
  photo: z
    .object({
      storagePath: z.string().min(1).max(300),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      mimeType: z.enum(["image/jpeg", "image/png"]),
      sizeBytes: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  context: z.object({ machine: z.string(), customer: z.string() }),
});

/**
 * SRV-01/02/06, CP-07: the customer raises a request. The owner is told at once
 * (in-app now, email with NOT-02); URGENT and HIGH say so first (decision 62).
 */
export async function raiseRequest(rpc: Rpc, actor: Actor, input: z.input<typeof raiseInput>) {
  if (actor.kind !== "USER" || actor.role !== "CUSTOMER") throw new TransitionError("FORBIDDEN", "Only a customer raises a service request");
  const i = parse(raiseInput, input);
  const label = requestLabel({ type: i.type, toner_colours: i.tonerColours });
  return (await rpc("rpc_raise_service_request", {
    p_actor_id: actor.id,
    p_idempotency_key: i.idempotencyKey,
    p_machine_id: i.machineId,
    p_input: {
      type: i.type,
      urgency: i.urgency,
      description: i.description,
      toner_colours: i.tonerColours,
      part_name: i.partName,
      preferred_date: i.preferredDate,
    },
    p_photo: i.photo
      ? { storage_path: i.photo.storagePath, sha256: i.photo.sha256, mime_type: i.photo.mimeType, size_bytes: i.photo.sizeBytes }
      : null,
    p_notifications: serviceNotifications("service.raised", [owner(i.ownerId)], {
      machine: i.context.machine,
      customer: i.context.customer,
      urgency: i.urgency,
      request: label,
      preview: preview(i.description),
    }),
  })) as { request_id: string; status: ServiceStatus; replayed: boolean };
}

// -----------------------------------------------------------------------------
// Steps on an existing request
// -----------------------------------------------------------------------------

export type StepInput =
  | { action: "ACKNOWLEDGE"; note?: string }
  | { action: "ASSIGN"; technician: string; plannedDate?: string | null; note?: string }
  | { action: "START"; note?: string }
  | {
      action: "RESOLVE";
      workDone: string;
      partsUsed?: string | null;
      costCents?: number | null;
      charge?: { amountCents: number; description: string } | null;
      discount?: { amountCents: number; description: string } | null;
      note?: string;
    }
  | { action: "CLOSE"; note?: string }
  | { action: "CONFIRM"; note?: string }
  | { action: "REOPEN"; reason: string }
  | { action: "CANCEL"; reason: string }
  | { action: "NOTE"; note: string };

const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACKNOWLEDGE"), note: text(1000).optional() }),
  z.object({ action: z.literal("ASSIGN"), technician: text(100).min(1, "Name the technician"), plannedDate: isoDate.nullable().optional(), note: text(1000).optional() }),
  z.object({ action: z.literal("START"), note: text(1000).optional() }),
  z.object({
    action: z.literal("RESOLVE"),
    workDone: text(1000).min(1, "Describe the work done"),
    partsUsed: text(500).nullable().optional(),
    costCents: z.number().int().nonnegative().nullable().optional(),
    charge: money.nullable().optional(),
    discount: money.nullable().optional(),
    note: text(1000).optional(),
  }),
  z.object({ action: z.literal("CLOSE"), note: text(1000).optional() }),
  z.object({ action: z.literal("CONFIRM"), note: text(1000).optional() }),
  z.object({ action: z.literal("REOPEN"), reason: text(1000).min(1, "Tell your rental company what is still wrong") }),
  z.object({ action: z.literal("CANCEL"), reason: text(1000).min(1, "A reason is required") }),
  z.object({ action: z.literal("NOTE"), note: text(1000).min(1, "Write the note") }),
]);

/** Who hears of a step, and with which message (SRV-05: the customer hears of every change). */
function messageFor(step: z.output<typeof stepSchema>, role: ServiceRole, r: RequestSnapshot): { event: NotificationEvent; to: "OWNER" | "CUSTOMER"; extra: NotificationContext } {
  switch (step.action) {
    case "ACKNOWLEDGE":
      return { event: "service.acknowledged", to: "CUSTOMER", extra: { preview: preview(step.note) } };
    case "ASSIGN":
      return {
        event: r.status === "ACKNOWLEDGED" ? "service.assigned" : "service.updated",
        to: "CUSTOMER",
        extra: { technician: step.technician, plannedDate: step.plannedDate ?? null, preview: preview(step.note) },
      };
    case "START":
      return { event: "service.started", to: "CUSTOMER", extra: { preview: preview(step.note) } };
    case "RESOLVE": {
      const money = [
        step.charge ? `${formatRupees(step.charge.amountCents)} will be added to your next bill (${step.charge.description}).` : null,
        step.discount ? `${formatRupees(step.discount.amountCents)} discount will be taken off your next bills.` : null,
      ].filter(Boolean);
      return { event: "service.resolved", to: "CUSTOMER", extra: { preview: preview([step.note, ...money].filter(Boolean).join(" ") || null) } };
    }
    case "CLOSE":
      return { event: "service.closed", to: "CUSTOMER", extra: { preview: preview(step.note) } };
    case "CONFIRM":
      return { event: "service.confirmed", to: "OWNER", extra: {} };
    case "REOPEN":
      return { event: "service.reopened", to: "OWNER", extra: { reason: step.reason } };
    case "CANCEL":
      return role === "CUSTOMER"
        ? { event: "service.cancelled_by_customer", to: "OWNER", extra: { reason: step.reason } }
        : { event: "service.cancelled", to: "CUSTOMER", extra: { reason: step.reason } };
    case "NOTE":
      return { event: "service.note", to: "CUSTOMER", extra: { preview: preview(step.note) } };
  }
}

/** Every step after raising: one rpc, the trail row, the audit entry and the notice in one transaction. */
export async function serviceStep(rpc: Rpc, actor: Actor, r: RequestSnapshot, input: StepInput) {
  const step = parse(stepSchema, input);
  const role = assertStep(step.action, actor, r);
  if (step.action === "RESOLVE" && step.discount && r.type !== "BREAKDOWN") throw new TransitionError("INVALID_INPUT", "A discount is for breakdowns only");
  const m = messageFor(step, role, r);
  const p_input: Record<string, unknown> = {};
  switch (step.action) {
    case "ASSIGN":
      Object.assign(p_input, { technician: step.technician, planned_date: step.plannedDate ?? null, note: step.note ?? null });
      break;
    case "RESOLVE":
      Object.assign(p_input, {
        work_done: step.workDone,
        parts_used: step.partsUsed ?? null,
        cost_cents: step.costCents ?? null,
        charge: step.charge ? { amount_cents: step.charge.amountCents, description: step.charge.description } : null,
        discount: step.discount ? { amount_cents: step.discount.amountCents, description: step.discount.description } : null,
        note: step.note ?? null,
      });
      break;
    case "REOPEN":
    case "CANCEL":
      p_input.reason = step.reason;
      break;
    default:
      p_input.note = step.note ?? null;
  }
  return (await rpc("rpc_service_request_action", {
    p_request_id: r.id,
    p_actor_id: actor.kind === "USER" ? actor.id : null,
    p_action: step.action,
    p_input,
    p_notifications: serviceNotifications(m.event, [m.to === "OWNER" ? owner(r.owner_id) : customer(r.customer_id)], context(r, m.extra)),
  })) as { request_id: string; status: ServiceStatus; credit_id: string | null };
}

const rateInput = z.object({ rating: z.number().int().min(1).max(5), comment: text(500).nullable().default(null) });

/** SRV-09: the customer rates a closed request once. */
export async function rateRequest(rpc: Rpc, actor: Actor, r: RequestSnapshot, input: z.input<typeof rateInput>) {
  if (actor.kind !== "USER" || actor.role !== "CUSTOMER" || actor.id !== r.customer_id) {
    throw new TransitionError("FORBIDDEN", "Only the customer rates the service");
  }
  if (r.status !== "CLOSED") throw new TransitionError("INVALID_STATE", "You can rate the service once the request is closed");
  const i = parse(rateInput, input);
  return (await rpc("rpc_rate_service_request", {
    p_request_id: r.id,
    p_actor_id: actor.id,
    p_rating: i.rating,
    p_comment: i.comment,
    p_notifications: serviceNotifications("service.rated", [owner(r.owner_id)], context(r, { rating: i.rating, preview: preview(i.comment) })),
  })) as { request_id: string; rating: number };
}
