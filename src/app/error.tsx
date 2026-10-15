"use client";

import { AppShell } from "@/components/app-shell";
import { ErrorView } from "@/components/errors/error-view";

/** Errors outside the portals (sign-in, password change, owner setup). */
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <AppShell>
      <ErrorView error={error} retry={retry} homeHref="/" />
    </AppShell>
  );
}
