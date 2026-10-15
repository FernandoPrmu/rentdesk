import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shown instead of a dashboard part that could not be read just now; the rest of the page still works. */
export function SummaryUnavailable({ href, message = "Your account summary could not be loaded just now." }: { href: string; message?: string }) {
  return (
    <div role="status" className="rounded-xl border border-dashed bg-background p-4 text-sm" data-testid="summary-unavailable">
      <p className="text-muted-foreground">{message}</p>
      <Link href={href} className={cn(buttonVariants({ variant: "outline" }), "mt-3 h-11 gap-2")}>
        <RefreshCw className="size-4" aria-hidden /> Try again
      </Link>
    </div>
  );
}
