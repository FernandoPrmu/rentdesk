"use client";

import { Send } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

/** 11.4: send the bill's notice to the customer again (the invoice always stays in their portal). */
export function ResendInvoiceButton({ invoiceId, action }: { invoiceId: string; action: (invoiceId: string) => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const hydrated = useHydrated();
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 gap-2"
      disabled={pending || !hydrated}
      data-testid="resend-invoice"
      onClick={() =>
        start(async () => {
          const result = await action(invoiceId);
          if (result.ok) toast.success("The customer was sent the bill again.");
          else toast.error(result.error);
        })
      }
    >
      <Send className="size-4" aria-hidden /> Send the bill again
    </Button>
  );
}
