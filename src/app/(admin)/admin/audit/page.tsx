import type { Metadata } from "next";
import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/lib/auth/current-user";
import { AUDIT_ACTIONS, AUDIT_ENTITIES, auditFilterSchema, listAudit, listOwnerChoices } from "@/lib/audit/queries";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Audit log" };

const label = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replaceAll("_", " ");

/** ADM-05: who did what, when, for which owner. Filters in the URL; newest first; 50 a page. */
export default async function AuditLogPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireUser("ADMIN");
  const filter = auditFilterSchema.parse(await searchParams);
  const [{ rows, next, actorMatches }, owners] = await Promise.all([listAudit(filter), listOwnerChoices()]);
  const params = new URLSearchParams(
    Object.entries(filter)
      .filter(([k, v]) => k !== "before" && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
  const key = params.toString();

  return (
    <>
      <PageHeader title="Audit log" description="Account changes, sign-ins, settings, tickets, invoices, payments, support views and exports." />
      <form key={key} action="/admin/audit" method="get" className="mb-4 grid gap-2 rounded-xl border bg-background p-3 sm:grid-cols-3" data-testid="audit-filters">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Who (username)
          <Input name="actor" defaultValue={filter.actor ?? ""} className="h-11 text-base" />
        </label>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>Owner</span>
          <ChoiceSelect name="owner" ariaLabel="Owner" emptyLabel="All owners" defaultValue={filter.owner ?? ""} options={owners.map((o) => ({ value: o.id, label: o.business_name }))} />
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>Action</span>
          <ChoiceSelect name="action" ariaLabel="Action" emptyLabel="All actions" defaultValue={filter.action ?? ""} options={AUDIT_ACTIONS.map((a) => ({ value: a, label: label(a) }))} />
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>Record</span>
          <ChoiceSelect name="entity" ariaLabel="Record" emptyLabel="All records" defaultValue={filter.entity ?? ""} options={AUDIT_ENTITIES.map((e) => ({ value: e, label: label(e) }))} />
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={filter.from ?? ""} className="h-11 rounded-md border bg-background px-2 text-base text-foreground" />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={filter.to ?? ""} className="h-11 rounded-md border bg-background px-2 text-base text-foreground" />
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <button type="submit" className={cn(buttonVariants(), "h-11 px-6")}>
            Filter
          </button>
          <Link href="/admin/audit" className={cn(buttonVariants({ variant: "outline" }), "h-11")}>
            Clear
          </Link>
        </div>
      </form>
      {actorMatches === 0 && <p className="mb-3 text-sm text-muted-foreground">No user matches that username.</p>}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">No entries match these filters.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-background" aria-label="Audit entries">
          {rows.map((r) => {
            const changed = Object.keys((r.details.changes as Record<string, unknown> | undefined) ?? {});
            return (
              <li key={r.id}>
                <Link href={`/admin/audit/${r.id}`} className="block px-4 py-3 hover:bg-muted/60" data-testid="audit-row">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium">
                      {label(r.action)} · {label(r.entity)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(r.created_at)}</span>
                  </div>
                  <p className="text-sm break-words text-muted-foreground">
                    {r.actor ?? (r.actor_id ? "Unknown user" : "System")}
                    {r.actor_role ? ` (${label(r.actor_role)})` : ""}
                    {r.owner ? ` · ${r.owner}` : ""}
                    {changed.length > 0 ? ` · ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? "…" : ""}` : ""}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <Link href={`/admin/audit?${key ? `${key}&` : ""}before=${next}`} className={cn(buttonVariants({ variant: "outline" }), "mt-4 h-12 w-full sm:w-auto")}>
          Older entries
        </Link>
      )}
    </>
  );
}
