import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/portal/portal-shell";
import { SectionView } from "@/components/reports/report-view";
import { requireUser } from "@/lib/auth/current-user";
import { openSupportView, SECTION_LABEL, SUPPORT_SECTIONS, type SupportSection, supportBase, supportList } from "@/lib/support/view";

export const metadata: Metadata = { title: "Support view" };

/** ADM-08: one of the owner's lists, read only (no links into owner actions). Logged. */
export default async function SupportSectionPage({ params, searchParams }: PageProps<"/admin/owners/[id]/support/[section]">) {
  const admin = await requireUser("ADMIN");
  const { id, section } = await params;
  if (!(SUPPORT_SECTIONS as readonly string[]).includes(section)) notFound();
  const { status } = await searchParams;
  const filter = typeof status === "string" ? status : undefined;
  const owner = await openSupportView(admin, id, `${supportBase(id)}/${section}${filter ? `?status=${filter}` : ""}`);
  const list = await supportList(section as SupportSection, id, filter);
  return (
    <>
      <PageHeader title={SECTION_LABEL[section as SupportSection]} description={`${owner.business_name}${filter ? ` · filter: ${filter.toLowerCase().replaceAll("_", " ")}` : ""} · up to 300 newest`} />
      <SectionView section={{ ...list, title: "" }} />
    </>
  );
}
