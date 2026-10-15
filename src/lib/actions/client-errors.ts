/**
 * What a form says when the Server Action call itself throws (decision 47, task 12):
 * the request may never have arrived, or it arrived and only the answer was lost. So
 * the message says what is safe, like the server's own failures:
 *   "safe"   the action has an idempotency key or re-checks the record's state;
 *   "check"  a repeat could do it twice, so the user looks first.
 * A throw is also how an old page meets a new deployment (its action IDs are gone),
 * so it asks the update banner to check for a new version (decision 89).
 */
export const UNREACHABLE_SAFE = "We could not reach the server, or its answer was lost. Tap the button again: it is never done twice.";
export const UNREACHABLE_CHECK = "We could not reach the server, or its answer was lost. Reload the page to see whether it was saved before trying again.";

export function unreachable(kind: "safe" | "check"): string {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("rentdesk:check-version"));
  return kind === "safe" ? UNREACHABLE_SAFE : UNREACHABLE_CHECK;
}
