import { CHECK_FIRST_MESSAGE, classifyActionError, type ActionFailure } from "../actions/errors.ts";

/**
 * How dispute actions report failures (task 8 review). The classification is shared
 * by every Server Action since task 12 (`src/lib/actions/errors.ts`); the dispute and
 * photo messages name their own button. Only relative imports.
 */

export { TransientError } from "../actions/errors.ts";

export const DISPUTE_RETRY_MESSAGE = "We could not confirm that your dispute was sent (the connection was slow). Tap Send again: it is never sent twice.";
export const PHOTO_RETRY_MESSAGE = "We could not confirm that your photo was sent (the connection was slow). Tap Send again: it is never sent twice.";
export const OWNER_RETRY_MESSAGE = CHECK_FIRST_MESSAGE;

export type DisputeFailure = ActionFailure;

export function classifyDisputeError(error: unknown, retryMessage = OWNER_RETRY_MESSAGE): DisputeFailure {
  return classifyActionError(error, retryMessage);
}
