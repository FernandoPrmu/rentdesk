/**
 * User-facing messages for errors raised by the workflow functions
 * (SQLSTATE codes in docs/database.md). Anything unexpected gets a generic message;
 * the detail is logged on the server only.
 */
export interface DbError {
  code?: string;
  message: string;
}

export function dbErrorMessage(error: DbError, context = "database"): string {
  switch (error.code) {
    case "RD400":
    case "RD409":
      return error.message;
    case "RD403":
      return "You are not allowed to do this.";
    case "RD404":
      return "This record was not found.";
    default:
      console.error(`[${context}]`, error.code, error.message);
      // A failure to answer is not a refusal: the change may have been saved (decision 47).
      return isTransientDbError(error) ? CHECK_FIRST_MESSAGE : "Something went wrong. Please try again.";
  }
}

export const CHECK_FIRST_MESSAGE = "The connection was slow and we could not confirm this. Reload the page to see whether it was saved, then try again if needed.";

/** Whether a Postgres / PostgREST / network error is a failure to answer rather than a refusal. */
export function isTransientDbError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code.startsWith("RD")) return false;
  // 57014 statement timeout, 08xxx connection, 53xxx resources, 40001/40P01 retryable, 57P0x shutdown.
  if (/^(57014|08...|53...|40001|40P01|57P0.)$/.test(code)) return true;
  return /fetch failed|network|timeout|timed out|ECONNRESET|socket|aborted|upstream/i.test(error.message ?? "");
}
