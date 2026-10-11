import { ChoiceSelect } from "@/components/forms/choice-select";
import { Button } from "@/components/ui/button";
import type { ServiceFilter } from "@/lib/service/queries";
import { SERVICE_STATUSES, SERVICE_TYPES, STATUS_LABEL, TYPE_LABEL, URGENCIES, URGENCY_LABEL } from "@/lib/service/states";

/** The owner's filters (status, urgency, type, machine, customer) as a plain GET form. */
export function ServiceFilters({
  filter,
  machines,
  customers,
}: {
  filter: ServiceFilter;
  machines: { id: string; label: string }[];
  customers: { id: string; name: string }[];
}) {
  return (
    <form method="get" role="search" className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" key={JSON.stringify(filter)}>
      <ChoiceSelect
        name="status"
        ariaLabel="Status"
        defaultValue={filter.status}
        options={[{ value: "OPEN", label: "Open" }, { value: "ALL", label: "All" }, ...SERVICE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
      />
      <ChoiceSelect name="urgency" ariaLabel="Urgency" defaultValue={filter.urgency ?? ""} emptyLabel="Any urgency" options={URGENCIES.map((u) => ({ value: u, label: URGENCY_LABEL[u] }))} />
      <ChoiceSelect name="type" ariaLabel="Type" defaultValue={filter.type ?? ""} emptyLabel="Any type" options={SERVICE_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
      <ChoiceSelect name="machine" ariaLabel="Machine" defaultValue={filter.machine ?? ""} emptyLabel="Any machine" options={machines.map((m) => ({ value: m.id, label: m.label }))} />
      <ChoiceSelect name="customer" ariaLabel="Customer" defaultValue={filter.customer ?? ""} emptyLabel="Any customer" options={customers.map((c) => ({ value: c.id, label: c.name }))} />
      <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
        Show
      </Button>
    </form>
  );
}
