/**
 * Billing engine errors. `code` is stable (server code maps it to a message);
 * `counter` says which meter counter it is about, when it is about one.
 */
export type BillingErrorCode =
  | "INVALID_INPUT"
  | "MISSING_READING"
  | "UNEXPECTED_READING"
  | "READING_ABOVE_COUNTER_MAX"
  | "READING_BELOW_PREVIOUS";

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly counter: "BW" | "COLOUR" | null;

  constructor(code: BillingErrorCode, message: string, counter: "BW" | "COLOUR" | null = null) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.counter = counter;
  }
}
