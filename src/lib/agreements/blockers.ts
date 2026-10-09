/**
 * app.return_machine refuses with RD409 "RETURN_BLOCKED:[...]" while a meter
 * reading waits for the owner's review (RET-01, rule 4: the final bill must use
 * confirmed numbers; unpaid invoices no longer block). This turns it into a
 * sentence that says what to do first.
 */

const PREFIX = "RETURN_BLOCKED:";

interface RawBlocker {
  kind: "ticket";
  cycle_no: number;
  status: string;
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
  const cycles = items.map((b) => b.cycle_no).join(", ");
  return cycles
    ? `This machine cannot be returned yet. First review the meter reading waiting for cycle ${cycles}, so the final bill uses confirmed numbers.`
    : "This machine cannot be returned yet: review the meter reading that is waiting first, so the final bill uses confirmed numbers.";
}
