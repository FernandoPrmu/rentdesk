import { AlarmClock, Siren, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { type ServiceStatus, STATUS_LABEL, TYPE_LABEL, type TonerColour, COLOUR_LABEL, type ServiceType, type Urgency, URGENCY_LABEL } from "@/lib/service/states";
import { cn } from "@/lib/utils";

/** Status, urgency and warning badges of service requests (SRV-05; decisions 61-62). */

const STATUS_STYLE: Record<ServiceStatus, string> = {
  NEW: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  ACKNOWLEDGED: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  ASSIGNED: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  IN_PROGRESS: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  RESOLVED: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  CLOSED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-muted text-muted-foreground line-through",
};

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  return (
    <Badge variant="secondary" className={cn("h-6 px-2.5 text-xs", STATUS_STYLE[status])} data-testid="service-status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** URGENT and HIGH stand out (decision 62); NORMAL and LOW stay quiet. */
export function UrgencyBadge({ urgency, quiet = false }: { urgency: Urgency; quiet?: boolean }) {
  if (urgency === "URGENT") {
    return (
      <Badge className="h-6 gap-1 bg-red-600 px-2.5 text-xs font-semibold text-white" data-testid="urgency-badge">
        <Siren aria-hidden /> Urgent
      </Badge>
    );
  }
  if (urgency === "HIGH") {
    return (
      <Badge className="h-6 bg-orange-500 px-2.5 text-xs font-semibold text-white" data-testid="urgency-badge">
        High
      </Badge>
    );
  }
  if (quiet) return null;
  return (
    <Badge variant="outline" className="h-6 px-2.5 text-xs">
      {URGENCY_LABEL[urgency]}
    </Badge>
  );
}

export function OverdueBadge() {
  return (
    <Badge variant="destructive" className="h-6 gap-1 px-2.5 text-xs" data-testid="service-overdue">
      <AlarmClock aria-hidden /> Not acknowledged in time
    </Badge>
  );
}

export function EscalatedBadge({ level }: { level: number }) {
  if (level < 1) return null;
  return (
    <Badge variant="destructive" className="h-6 px-2.5 text-xs" data-testid="service-escalated">
      {level >= 2 ? "Escalated to admin" : "Reminder sent"}
    </Badge>
  );
}

/** On a rented machine with an open request: it stays Rented (decision 63). */
export function InServiceBadge() {
  return (
    <Badge className="h-6 gap-1 bg-amber-500 px-2.5 text-xs text-white" data-testid="in-service">
      <Wrench aria-hidden /> Service in progress
    </Badge>
  );
}

/** "Toner: cyan, magenta" / "Spare part: drum unit" / "Breakdown / repair". */
export function requestTitle(r: { type: ServiceType; tonerColours: TonerColour[]; partName?: string | null }): string {
  if (r.type === "TONER" && r.tonerColours.length > 0) return `Toner: ${r.tonerColours.map((c) => COLOUR_LABEL[c].toLowerCase()).join(", ")}`;
  if (r.type === "SPARE_PART" && r.partName) return `Spare part: ${r.partName}`;
  return TYPE_LABEL[r.type];
}

export function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <span className={cn("tracking-tight text-amber-500", className)} aria-label={`${rating} out of 5 stars`}>
      {"★".repeat(rating)}
      <span className="text-muted-foreground/40">{"★".repeat(5 - rating)}</span>
    </span>
  );
}
