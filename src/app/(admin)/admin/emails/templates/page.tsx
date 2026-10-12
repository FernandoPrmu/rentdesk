import type { Metadata } from "next";

import { TemplateListPage } from "@/components/notifications/template-pages";

export const metadata: Metadata = { title: "Email templates" };

export default function Page() {
  return <TemplateListPage role="ADMIN" base="/admin/emails" />;
}
