"use client";

import { ErrorView } from "@/components/errors/error-view";

/** Errors inside the customer portal keep its header and navigation. */
export default function CustomerError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/customer" />;
}
