import { assertNotProduction } from "../../scripts/lib/production-lock.ts";

import { clearSessions } from "./auth";
import { deleteE2eAccounts, deleteE2eMachines, restoreDemoState } from "./demo";

/** Start every run from the seed state, even if an earlier run was interrupted. */
export default async function globalSetup() {
  // The production lock first (decision 95): e2e signs in, creates and deletes accounts.
  await assertNotProduction("the e2e tests", [process.env]);
  clearSessions();
  await restoreDemoState();
  await deleteE2eMachines();
  await deleteE2eAccounts();
}
