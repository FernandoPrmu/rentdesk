import { BillingError } from "../billing/errors.ts";
import { dbErrorMessage } from "../db-errors.ts";
import { RpcError, TransitionError } from "../tickets/transitions.ts";

/**
 * How dispute actions report failures (task 8 review). Workflow refusals (RD codes,
 * transition and billing errors) are shown in plain words. Everything else is a
 * transient failure: a statement timeout (57014) when the free-tier database
 * stalls, a dropped connection, a failed read. The transaction was rolled back or
 * the read did not happen, so the user is told to retry, which is safe: the
 * dispute carries an idempotency key and the owner's answers re-check the state.
 * Only relative imports.
 */

export const DISPUTE_RETRY_MESSAGE = "We could not confirm that your dispute was sent (the connection was slow). Tap Send again: it is never sent twice.";
export const PHOTO_RETRY_MESSAGE = "We could not confirm that your photo was sent (the connection was slow). Tap Send again: it is never sent twice.";
export const OWNER_RETRY_MESSAGE = "The server was too slow to confirm this. Reload the ticket to see whether it was saved, then try again if needed.";

/** A read that failed (timeout, network): never treated as "nothing there". */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

export type DisputeFailure = { kind: "REFUSED"; message: string } | { kind: "TRANSIENT"; message: string };

export function classifyDisputeError(error: unknown, retryMessage = OWNER_RETRY_MESSAGE): DisputeFailure {
  if (error instanceof TransitionError) return { kind: "REFUSED", message: error.message.replace(/^[^:]+: /, "") };
  if (error instanceof RpcError && error.code?.startsWith("RD")) {
    return { kind: "REFUSED", message: dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }) };
  }
  if (error instanceof BillingError) return { kind: "REFUSED", message: error.message };
  return { kind: "TRANSIENT", message: retryMessage };
}
