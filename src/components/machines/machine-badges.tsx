import { Badge } from "@/components/ui/badge";
import { MACHINE_STATUS_LABEL, MACHINE_TYPE_LABEL, type MachineStatus, type MachineType } from "@/lib/machines/schemas";

export function MachineStatusBadge({ status }: { status: MachineStatus }) {
  const variant = status === "AVAILABLE" ? "secondary" : status === "RENTED" ? "default" : status === "UNDER_REPAIR" ? "destructive" : "outline";
  return <Badge variant={variant}>{MACHINE_STATUS_LABEL[status]}</Badge>;
}

export function MachineTypeBadge({ type }: { type: MachineType }) {
  return <Badge variant="outline">{MACHINE_TYPE_LABEL[type]}</Badge>;
}
