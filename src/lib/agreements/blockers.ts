import { INVOICE_STATUS_LABEL, TICKET_STATUS_LABEL } from "@/lib/status-labels";

/**
 * app.return_machine refuses with RD409 "RETURN_BLOCKED:[...]" while the agreement
 * has open tickets or unpaid invoices (MAC-04). This turns it into a sentence that
 * says what to resolve first.
 */

const PREFIX = "RETURN_BLOCKED:";

interface RawBlocker {
  kind: "ticket" | "invoice";
  cycle_no?: number;
  invoice_no?: string | null;
  status: string;
}

export function describeBlocker(b: RawBlocker): string {
  if (b.kind === "ticket") return `billing ticket for cycle ${b.cycle_no} (${TICKET_STATUS_LABEL[b.status] ?? b.status})`;
  return `invoice ${b.invoice_no ?? "(not issued)"} (${INVOICE_STATUS_LABEL[b.status] ?? b.status})`;
}

/** The user-facing message, or null when the error is something else. */
export function returnBlockedMessage(message: string): string | null {
  if (!message.startsWith(PREFIX)) return null;
  let items: RawBlocker[] = [];
  try {
    items = JSON.parse(message.slice(PREFIX.length)) as RawBlocker[];
  } catch {
    // Fall through to the generic sentence.
  }
  const list = items.map(describeBlocker).join("; ");
  return list
    ? `This machine cannot be returned yet. Resolve first: ${list}.`
    : "This machine cannot be returned yet: close its open billing ticket and unpaid invoices first.";
}
