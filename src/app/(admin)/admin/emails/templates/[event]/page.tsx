import type { Metadata } from "next";

import { TemplateEditPage } from "@/components/notifications/template-pages";

export const metadata: Metadata = { title: "Edit email template" };

export default async function Page({ params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  return <TemplateEditPage role="ADMIN" base="/admin/emails" event={event} />;
}
