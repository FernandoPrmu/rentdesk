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
      return "Something went wrong. Please try again.";
  }
}
