import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HomePage() {
  return (
    <AppShell>
      <section className="flex flex-1 flex-col justify-center gap-6">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">Your copier rentals, in one place</h1>
          <p className="text-base text-muted-foreground">
            Send your meter reading, see your invoice, upload your payment slip and ask for
            service, all from your phone.
          </p>
        </div>
        <Link href="/login" className={cn(buttonVariants({ size: "lg" }), "h-12 w-full text-base")}>
          Sign in
        </Link>
        <p className="text-center text-sm text-muted-foreground">
          No account? Ask your machine owner for your login details.
        </p>
      </section>
    </AppShell>
  );
}
