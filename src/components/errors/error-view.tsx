"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Friendly page error (error.tsx in the root and each portal). Server errors reach the
 * browser without details (only a reference), so the text is the same for all: most
 * failures on the free tier are a slow database or connection, and "Try again"
 * fetches the page again. Nothing the user sent is lost or sent twice by retrying a
 * page. Also asks the update banner to check for a new version (decision 89): an
 * old page talking to a new deployment fails this way.
 */
export function ErrorView({ error, retry, homeHref }: { error: Error & { digest?: string }; retry: () => void; homeHref: string }) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    console.error(error);
    window.dispatchEvent(new Event("rentdesk:check-version"));
  }, [error]);

  return (
    <section role="alert" aria-labelledby="error-title" className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center">
      <CircleAlert aria-hidden className="size-12 text-destructive" />
      <div className="space-y-2">
        <h1 id="error-title" className="text-2xl font-bold tracking-tight">
          This page could not load
        </h1>
        <p className="text-base text-muted-foreground">
          This is usually a slow connection or a busy server. Tap Try again. If it keeps happening, wait a minute and try again.
        </p>
        {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button
          size="lg"
          className="h-12 w-full text-base"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            retry();
            window.setTimeout(() => setBusy(false), 4000);
          }}
        >
          {busy ? "Trying again…" : "Try again"}
        </Button>
        <Link href={homeHref} className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-12 w-full text-base")}>
          Go to Home
        </Link>
      </div>
    </section>
  );
}

/** Friendly "not found" (not-found.tsx in the root and each portal). Also shown for another tenant's records (rule 54). */
export function NotFoundView({ homeHref, what = "page" }: { homeHref: string; what?: string }) {
  return (
    <section aria-labelledby="not-found-title" className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center">
      <p aria-hidden className="text-5xl font-bold text-muted-foreground">
        404
      </p>
      <div className="space-y-2">
        <h1 id="not-found-title" className="text-2xl font-bold tracking-tight">
          We could not find this {what}
        </h1>
        <p className="text-base text-muted-foreground">It may have been removed, or the link is wrong. Check the address or go back to Home.</p>
      </div>
      <Link href={homeHref} className={cn(buttonVariants({ size: "lg" }), "h-12 w-full text-base")}>
        Go to Home
      </Link>
    </section>
  );
}
