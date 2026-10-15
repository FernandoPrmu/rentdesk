import { BillingError } from "../billing/errors.ts";
import { CHECK_FIRST_MESSAGE, dbErrorMessage } from "../db-errors.ts";
import { RpcError, TransitionError } from "../tickets/transitions.ts";

/**
 * How every Server Action reports a failure (decision 47, applied to all actions in
 * task 12). Two kinds:
 *   - REFUSED: the workflow said no (RD codes, transition and billing rules). Shown in
 *     plain words; nothing changed.
 *   - TRANSIENT: anything else (a statement timeout when the free-tier database
 *     stalls, a dropped connection, a failed read). We cannot know whether the change
 *     was saved, so the message says what is safe:
 *       SAFE_RETRY   the action carries an idempotency key or re-checks the record's
 *                    state, so tapping again can never do it twice;
 *       CHECK_FIRST  a repeat could do it twice (creating an account, refunding), so
 *                    the user looks first.
 * A read that fails is never taken as "nothing there": `must()` turns it into a
 * TRANSIENT failure. Only relative imports (used by scripts too).
 */

export const SAFE_RETRY_MESSAGE = "The connection was slow and we could not confirm this. Tap the button again: it is never done twice.";
export { CHECK_FIRST_MESSAGE, isTransientDbError } from "../db-errors.ts";

/** A read that failed (timeout, network): never treated as "nothing there". */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

export type ActionFailure = { kind: "REFUSED"; message: string } | { kind: "TRANSIENT"; message: string };

export function classifyActionError(error: unknown, retryMessage: string = CHECK_FIRST_MESSAGE): ActionFailure {
  if (error instanceof TransitionError) return { kind: "REFUSED", message: error.message.replace(/^[^:]+: /, "") };
  if (error instanceof RpcError && error.code?.startsWith("RD")) {
    return { kind: "REFUSED", message: dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }) };
  }
  if (error instanceof BillingError) return { kind: "REFUSED", message: error.message };
  return { kind: "TRANSIENT", message: retryMessage };
}

/** The `{ ok: false }` result for an action, logging transient failures on the server. */
export function actionFailure(error: unknown, context: string, retryMessage: string = CHECK_FIRST_MESSAGE): { ok: false; error: string } {
  const f = classifyActionError(error, retryMessage);
  if (f.kind === "TRANSIENT") console.error(`[${context}] transient:`, error instanceof Error ? `${error.name}: ${error.message}` : error);
  return { ok: false, error: f.message };
}

/** The data of a Supabase read, or a TransientError when the read itself failed. */
export function must<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new TransientError(`${what}: ${result.error.message}`);
  return result.data;
}
