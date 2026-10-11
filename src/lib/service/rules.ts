import { HOUR_LOOKAHEAD_MS } from "../tickets/deadlines.ts";
import { isPriority, TONER_COLOURS, type ServiceType, type TonerColour, type Urgency } from "./states.ts";

/**
 * Pure service request rules: toner colours (SRV-06) and acknowledgement escalation
 * (SRV-08, spec 7.3; decision 61). The database re-checks the colours
 * (app.raise_service_request); the daily job uses the escalation decision.
 * Only relative imports.
 */

export type MachineType = "MONO" | "COLOUR";

/**
 * The toner colours stored with a request. A mono machine takes black only, set
 * automatically; a colour machine needs at least one colour. Other request types
 * carry none.
 */
export function tonerColoursFor(
  type: ServiceType,
  machineType: MachineType,
  chosen: readonly string[],
): { ok: true; colours: TonerColour[] } | { ok: false; error: string } {
  const unique = [...new Set(chosen)];
  if (unique.some((c) => !(TONER_COLOURS as readonly string[]).includes(c))) return { ok: false, error: "Unknown toner colour" };
  const colours = TONER_COLOURS.filter((c) => unique.includes(c));
  if (type !== "TONER") return colours.length === 0 ? { ok: true, colours: [] } : { ok: false, error: "Toner colours are only for toner requests" };
  if (machineType === "MONO") {
    return colours.every((c) => c === "BLACK") ? { ok: true, colours: ["BLACK"] } : { ok: false, error: "A mono machine uses black toner only" };
  }
  return colours.length > 0 ? { ok: true, colours } : { ok: false, error: "Choose the toner colour(s) you need" };
}

/** owner_settings_effective: hours to acknowledge, then hours until the admin is told. */
export interface ServiceSettings {
  service_ack_hours_urgent: number;
  service_ack_hours_normal: number;
  service_admin_escalation_hours_urgent: number;
  service_admin_escalation_hours_normal: number;
}

export const SERVICE_DEFAULTS: ServiceSettings = {
  service_ack_hours_urgent: 4,
  service_ack_hours_normal: 24,
  service_admin_escalation_hours_urgent: 8,
  service_admin_escalation_hours_normal: 48,
};

const HOUR_MS = 3_600_000;

/** URGENT and HIGH use the urgent times; NORMAL and LOW the normal ones (decision 61). */
export function escalationHours(urgency: Urgency, s: ServiceSettings): { owner: number; admin: number } {
  return isPriority(urgency)
    ? { owner: s.service_ack_hours_urgent, admin: Math.max(s.service_admin_escalation_hours_urgent, s.service_ack_hours_urgent) }
    : { owner: s.service_ack_hours_normal, admin: Math.max(s.service_admin_escalation_hours_normal, s.service_ack_hours_normal) };
}

/** When the owner should have acknowledged (shown as "Not acknowledged in time" after it). */
export function acknowledgeBy(createdAt: Date, urgency: Urgency, s: ServiceSettings): Date {
  return new Date(createdAt.getTime() + escalationHours(urgency, s).owner * HOUR_MS);
}

export const ESCALATION_OWNER = 1;
export const ESCALATION_ADMIN = 2;

export interface ServiceEscalation {
  level: typeof ESCALATION_OWNER | typeof ESCALATION_ADMIN;
  /** Hours since the request was raised (for the message). */
  hours: number;
}

/**
 * The escalation due for a request still New at `now`, or null. Hours count from
 * when it was raised, with the hour of lookahead of the other hour-based stages
 * (Vercel fires anywhere in the scheduled hour, rule 20). One run a day means a
 * 4-hour escalation can come up to a day late (rule 26). When both times passed
 * since the last run, the request goes straight to the admin level.
 */
export function decideServiceEscalation(
  r: { created_at: string; urgency: Urgency; escalation_level: number },
  now: Date,
  s: ServiceSettings,
): ServiceEscalation | null {
  const created = new Date(r.created_at).getTime();
  const hours = escalationHours(r.urgency, s);
  const reached = (h: number) => created + h * HOUR_MS <= now.getTime() + HOUR_LOOKAHEAD_MS;
  const elapsed = Math.max(0, Math.floor((now.getTime() - created) / HOUR_MS));
  if (r.escalation_level < ESCALATION_ADMIN && reached(hours.admin)) return { level: ESCALATION_ADMIN, hours: elapsed };
  if (r.escalation_level < ESCALATION_OWNER && reached(hours.owner)) return { level: ESCALATION_OWNER, hours: elapsed };
  return null;
}

/** Days a breakdown kept the machine down: raised → resolved (or now), whole days, at least 0. */
export function daysDown(createdAt: string, resolvedAt: string | null, now: Date = new Date()): number {
  const end = resolvedAt ? new Date(resolvedAt).getTime() : now.getTime();
  return Math.max(0, Math.floor((end - new Date(createdAt).getTime()) / (24 * HOUR_MS)));
}
