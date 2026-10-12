import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { auditChanges, auditValue } from "@/lib/audit/changes";
import { getAudit } from "@/lib/audit/queries";
import { formatDateTime } from "@/lib/format";
import { settingLabel } from "@/lib/settings/view";

export const metadata: Metadata = { title: "Audit entry" };

const label = (s: string) => (s.charAt(0) + s.slice(1).toLowerCase()).replaceAll("_", " ");

/** ADM-05: one audit entry with its old -> new values and the full details. */
export default async function AuditEntryPage({ params }: PageProps<"/admin/audit/[id]">) {
  await requireUser("ADMIN");
  const { id } = await params;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) notFound();
  const entry = await getAudit(n);
  if (!entry) notFound();
  const changes = auditChanges(entry.details);
  const settings = entry.entity === "platform_settings" || entry.entity === "owner_settings";
  const rest = Object.fromEntries(Object.entries(entry.details).filter(([k]) => k !== "changes"));

  return (
    <div className="max-w-3xl">
      <BackLink href="/admin/audit" label="Audit log" />
      <PageHeader title={`${label(entry.action)} · ${label(entry.entity)}`} description={formatDateTime(entry.created_at)} />
      <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border bg-background p-4 text-sm" data-testid="audit-entry">
        <dt className="text-muted-foreground">Who</dt>
        <dd>
          {entry.actor ?? (entry.actor_id ? "Unknown user" : "System")}
          {entry.actor_role ? ` (${label(entry.actor_role)})` : ""}
        </dd>
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          {entry.owner ? (
            <Link href={`/admin/owners/${entry.owner_id}`} className="text-primary underline-offset-4 hover:underline">
              {entry.owner}
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt className="text-muted-foreground">Record</dt>
        <dd className="break-all">
          {entry.entity}
          {entry.entity_id ? ` · ${entry.entity_id}` : ""}
        </dd>
        <dt className="text-muted-foreground">Entry</dt>
        <dd>#{entry.id}</dd>
      </dl>

      {changes.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 text-lg font-semibold">Changes</h2>
          <div className="overflow-x-auto rounded-xl border bg-background">
            <table className="w-full text-sm" data-testid="audit-changes">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Field</th>
                  <th className="px-3 py-2 font-medium">Old</th>
                  <th className="px-3 py-2 font-medium">New</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {changes.map((c) => (
                  <tr key={c.field}>
                    <td className="px-3 py-2 align-top">
                      {settings ? settingLabel(c.field) : c.field}
                      {settings && <span className="block text-xs text-muted-foreground">{c.field}</span>}
                    </td>
                    <td className="px-3 py-2 align-top break-all text-muted-foreground">{auditValue(c.old)}</td>
                    <td className="px-3 py-2 align-top font-medium break-all">{auditValue(c.new)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {Object.keys(rest).length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Details</h2>
          <pre className="overflow-x-auto rounded-xl border bg-background p-4 text-xs break-all whitespace-pre-wrap">{JSON.stringify(rest, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
