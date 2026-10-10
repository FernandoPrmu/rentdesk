import { Building2, ChevronRight, FileText, KeyRound, Receipt } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SignOutButton } from "@/components/auth/account-menu";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Settings" };

const LINKS = [
  { href: "/owner/settings/company", label: "Company details and logo", icon: Building2 },
  { href: "/owner/settings/billing", label: "Billing: late fee", icon: Receipt },
  { href: "/owner/settings/invoice-template", label: "Invoice template and letterhead", icon: FileText },
  { href: "/change-password", label: "Change password", icon: KeyRound },
];

export default async function OwnerSettingsPage() {
  await requireUser("OWNER");
  return (
    <div className="max-w-xl space-y-5">
      <PageHeader title="Settings" />
      <ul className="divide-y overflow-hidden rounded-xl border bg-background">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex min-h-14 items-center gap-3 px-4 hover:bg-muted/60">
              <l.icon className="size-5 text-muted-foreground" aria-hidden />
              <span className="flex-1 font-medium">{l.label}</span>
              <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      <SignOutButton />
    </div>
  );
}
