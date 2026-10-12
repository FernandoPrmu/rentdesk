import { ChevronRight, FileText, ListChecks } from "lucide-react";
import Link from "next/link";

/** Links from the email settings page to the templates and the delivery log. */
export function EmailLinks({ base }: { base: string }) {
  const links = [
    { href: `${base}/templates`, label: "Email templates", hint: "Change the wording, with a live preview", icon: FileText },
    { href: `${base}/log`, label: "Delivery log", hint: "What was sent, failed, skipped or read", icon: ListChecks },
  ];
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-background">
      {links.map((l) => (
        <li key={l.href}>
          <Link href={l.href} className="flex min-h-16 items-center gap-3 px-4 py-2 hover:bg-muted/60">
            <l.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{l.label}</span>
              <span className="block text-sm text-muted-foreground">{l.hint}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
