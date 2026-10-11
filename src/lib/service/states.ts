/**
 * Service request statuses and steps (spec 4.9, 7.2; SRV-03, SRV-04, SRV-05, SRV-09;
 * decision 57). One table says which role may take which step from which status;
 * app.service_transition_allowed and app.service_request_action enforce the same
 * in the database. Pure, only relative imports (DB tests import it under Node).
 */

export const SERVICE_STATUSES = ["NEW", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED", "CANCELLED"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_TYPES = ["BREAKDOWN", "TONER", "SPARE_PART", "MAINTENANCE", "OTHER"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const URGENCIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const TONER_COLOURS = ["BLACK", "CYAN", "MAGENTA", "YELLOW"] as const;
export type TonerColour = (typeof TONER_COLOURS)[number];

export const STATUS_LABEL: Record<ServiceStatus, string> = {
  NEW: "New",
  ACKNOWLEDGED: "Acknowledged",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export const TYPE_LABEL: Record<ServiceType, string> = {
  BREAKDOWN: "Breakdown / repair",
  TONER: "Toner",
  SPARE_PART: "Spare part",
  MAINTENANCE: "Maintenance",
  OTHER: "Other",
};

export const URGENCY_LABEL: Record<Urgency, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

export const COLOUR_LABEL: Record<TonerColour, string> = { BLACK: "Black", CYAN: "Cyan", MAGENTA: "Magenta", YELLOW: "Yellow" };

/** Open = still needs someone to act (the customer's "Resolved" confirmation included). */
export const OPEN_STATUSES: readonly ServiceStatus[] = ["NEW", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED"];
/** The machine shows "Service in progress" while a request is New through In progress. */
export const ACTIVE_STATUSES: readonly ServiceStatus[] = ["NEW", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS"];

export const isOpen = (s: ServiceStatus) => OPEN_STATUSES.includes(s);

/** URGENT and HIGH come first in lists and use the urgent escalation times (decision 61). */
export const isPriority = (u: Urgency) => u === "URGENT" || u === "HIGH";
export const URGENCY_RANK: Record<Urgency, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/** Allowed status changes (decision 57). Mirrors app.service_transition_allowed. */
export const TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  NEW: ["ACKNOWLEDGED", "CANCELLED"],
  ACKNOWLEDGED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export function transitionAllowed(from: ServiceStatus, to: ServiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type ServiceRole = "OWNER" | "CUSTOMER";
export type ServiceAction = "ACKNOWLEDGE" | "ASSIGN" | "START" | "RESOLVE" | "CLOSE" | "CONFIRM" | "REOPEN" | "CANCEL" | "NOTE";

interface ActionRule {
  /** Who may take the step. */
  roles: readonly ServiceRole[];
  /** Statuses it starts from (per role when they differ). */
  from: Partial<Record<ServiceRole, readonly ServiceStatus[]>>;
  /** The new status; null = no status change (a trail row only). */
  to: ServiceStatus | ((from: ServiceStatus) => ServiceStatus | null) | null;
  /** A reason is required (shown to the other side). */
  needsReason: boolean;
}

export const SERVICE_ACTIONS: Record<ServiceAction, ActionRule> = {
  ACKNOWLEDGE: { roles: ["OWNER"], from: { OWNER: ["NEW"] }, to: "ACKNOWLEDGED", needsReason: false },
  // Assigning again while Assigned or In progress changes the technician or the planned date.
  ASSIGN: {
    roles: ["OWNER"],
    from: { OWNER: ["ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS"] },
    to: (from) => (from === "ACKNOWLEDGED" ? "ASSIGNED" : null),
    needsReason: false,
  },
  START: { roles: ["OWNER"], from: { OWNER: ["ASSIGNED"] }, to: "IN_PROGRESS", needsReason: false },
  RESOLVE: { roles: ["OWNER"], from: { OWNER: ["IN_PROGRESS"] }, to: "RESOLVED", needsReason: false },
  CLOSE: { roles: ["OWNER"], from: { OWNER: ["RESOLVED"] }, to: "CLOSED", needsReason: false },
  CONFIRM: { roles: ["CUSTOMER"], from: { CUSTOMER: ["RESOLVED"] }, to: "CLOSED", needsReason: false },
  REOPEN: { roles: ["CUSTOMER"], from: { CUSTOMER: ["RESOLVED"] }, to: "IN_PROGRESS", needsReason: true },
  // The customer cancels only before the rental company acts; the owner at any open step.
  CANCEL: { roles: ["OWNER", "CUSTOMER"], from: { OWNER: OPEN_STATUSES, CUSTOMER: ["NEW"] }, to: "CANCELLED", needsReason: true },
  NOTE: { roles: ["OWNER"], from: { OWNER: OPEN_STATUSES }, to: null, needsReason: false },
};

export function targetStatus(action: ServiceAction, from: ServiceStatus): ServiceStatus | null {
  const to = SERVICE_ACTIONS[action].to;
  return typeof to === "function" ? to(from) : to;
}

/** Why a role may not take a step now, or null when it may. */
export function serviceRefusal(action: ServiceAction, role: ServiceRole | "ADMIN", status: ServiceStatus): string | null {
  const rule = SERVICE_ACTIONS[action];
  if (role === "ADMIN" || !rule.roles.includes(role)) return role === "CUSTOMER" ? "Only the rental company can do this" : "Only the customer can do this";
  if (!(rule.from[role] ?? []).includes(status)) {
    if (action === "CANCEL" && role === "CUSTOMER" && isOpen(status)) return "Your rental company is already working on this request. Ask them to cancel it.";
    return `This request is ${STATUS_LABEL[status].toLowerCase()}, so it cannot be changed this way`;
  }
  const to = targetStatus(action, status);
  if (to && !transitionAllowed(status, to)) return `This request is ${STATUS_LABEL[status].toLowerCase()}`;
  return null;
}

/** The steps a role can take now (buttons on the request page). */
export function availableActions(role: ServiceRole, status: ServiceStatus): ServiceAction[] {
  return (Object.keys(SERVICE_ACTIONS) as ServiceAction[]).filter((a) => serviceRefusal(a, role, status) === null);
}
