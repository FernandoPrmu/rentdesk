import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TemplateEditor } from "@/components/notifications/template-editor";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/current-user";
import { getBranding } from "@/lib/branding/company";
import { type Audience, EVENTS, isCatalogEvent } from "@/lib/notifications/events";
import { templateStates } from "@/lib/notifications/queries";

const AUDIENCE_TITLE: Record<Audience, string> = { CUSTOMER: "Emails to customers", OWNER: "Emails to owners", ADMIN: "Emails to admins" };
const CATEGORY_LABEL: Record<string, string> = { ESSENTIAL: "Always sent", UPDATE: "Update", REMINDER: "Reminder" };

/** Settings › Email templates (NOT-04): every email, grouped by who receives it. */
export async function TemplateListPage({ role, base }: { role: "OWNER" | "ADMIN"; base: string }) {
  const user = await requireUser(role);
  const states = await templateStates(role === "OWNER" ? user.id : null);
  // Owners edit what their customers and they themselves receive; admin alerts are the admin's.
  const audiences: Audience[] = role === "OWNER" ? ["CUSTOMER", "OWNER"] : ["CUSTOMER", "OWNER", "ADMIN"];
  return (
    <div className="max-w-2xl space-y-5">
      <BackLink href={base} label="Emails" />
      <PageHeader
        title="Email templates"
        description={
          role === "OWNER"
            ? "Change the wording of the emails RentDesk sends for you. Your text replaces the default for your company only."
            : "The default wording for every owner. An owner's own text replaces it for that owner."
        }
      />
      {audiences.map((audience) => {
        const rows = states.filter((s) => s.audience === audience);
        if (rows.length === 0) return null;
        return (
          <section key={audience} className="space-y-2">
            <h2 className="text-lg font-semibold">{AUDIENCE_TITLE[audience]}</h2>
            <ul className="divide-y overflow-hidden rounded-xl border bg-background">
              {rows.map((s) => (
                <li key={s.event}>
                  <Link href={`${base}/templates/${s.event}`} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-muted/60">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{s.label}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1.5">
                        <Badge variant="outline">{CATEGORY_LABEL[s.category]}</Badge>
                        {s.own && <Badge variant="secondary">{role === "OWNER" ? "Your text" : "Changed"}</Badge>}
                      </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** One template with the live preview. */
export async function TemplateEditPage({ role, base, event }: { role: "OWNER" | "ADMIN"; base: string; event: string }) {
  const user = await requireUser(role);
  if (!isCatalogEvent(event) || EVENTS[event].email === null) notFound();
  const states = await templateStates(role === "OWNER" ? user.id : null);
  const state = states.find((s) => s.event === event);
  if (!state) notFound();
  const branding = role === "OWNER" ? await getBranding(user.id) : null;
  const companyName = branding?.companyName ?? "RentDesk";
  return (
    <div className="space-y-5">
      <BackLink href={`${base}/templates`} label="Email templates" />
      <PageHeader title={state.label} description={`${AUDIENCE_TITLE[state.audience as Audience]} · ${CATEGORY_LABEL[state.category]}`} />
      <TemplateEditor
        event={event}
        initial={state.own ?? state.inherited}
        inherited={state.inherited}
        inheritedLabel={state.inheritedFrom === "GLOBAL" ? "the RentDesk default set by the admin" : "the built-in RentDesk text"}
        hasOwn={state.own !== null}
        companyName={companyName}
        logoUrl={branding?.logoUrl ?? null}
      />
    </div>
  );
}
