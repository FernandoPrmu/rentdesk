import { Eye } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { SECTION_LABEL, SUPPORT_SECTIONS, supportBase } from "@/lib/support/view";

/**
 * ADM-08: every support page sits under this banner and section bar. The pages
 * log each view themselves (openSupportView) and render no forms or actions.
 */
export default async function SupportLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = supportBase(id);
  return (
    <div>
      <div role="status" className="sticky top-14 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-y border-amber-500/60 bg-amber-100 px-4 py-2 text-sm text-amber-950 md:-mx-6 md:px-6 dark:bg-amber-950 dark:text-amber-100" data-testid="support-banner">
        <Eye className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 font-semibold">Support view — read only</span>
        <Link href={`/admin/owners/${id}`} className="inline-flex min-h-10 items-center font-medium underline underline-offset-4">
          Leave
        </Link>
      </div>
      <nav aria-label="Support sections" className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto pb-1">
        {[
          { href: base, label: "Dashboard" },
          { href: `${base}/reports`, label: "Reports" },
          ...SUPPORT_SECTIONS.map((s) => ({ href: `${base}/${s}`, label: SECTION_LABEL[s] })),
        ].map((l) => (
          <Link key={l.href} href={l.href} className="inline-flex h-10 shrink-0 items-center rounded-full border bg-background px-3 text-sm whitespace-nowrap hover:bg-muted">
            {l.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
