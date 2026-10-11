import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { recordBaselineAction } from "@/app/(owner)/owner/agreements/actions";
import { BaselineForm } from "@/components/agreements/baseline-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { uuidSchema } from "@/lib/accounts/schemas";
import { getBaselineView } from "@/lib/agreements/baseline";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "New meter baseline" };

/** Spec 6.4, 11.2, 11.8 (decision 51): the meter was replaced or reset; the next bill measures from the new baseline. */
export default async function BaselinePage({ params }: PageProps<"/owner/agreements/[id]/baseline">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const view = await getBaselineView(owner, id);
  if (!view) notFound();
  return (
    <div className="max-w-xl space-y-5">
      <div>
        <BackLink href={`/owner/agreements/${id}`} label="Agreement" />
        <PageHeader title="New meter baseline" description={view.machine} />
      </div>
      {view.blocked ? (
        <p role="status" className="rounded-lg bg-muted px-3 py-2" data-testid="baseline-blocked">
          {view.blocked}
        </p>
      ) : (
        <BaselineForm view={view} action={recordBaselineAction} />
      )}
    </div>
  );
}
