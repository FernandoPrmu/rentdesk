import { assertNotProduction } from "../../scripts/lib/production-lock.ts";

import { deleteE2eAccounts, deleteE2eMachines, restoreDemoState } from "./demo";

/** Leave the seed accounts as the seed created them. */
export default async function globalTeardown() {
  // Runs even when the setup refused: never touch a production database (decision 95).
  await assertNotProduction("the e2e tests", [process.env]);
  await restoreDemoState();
  await deleteE2eMachines();
  await deleteE2eAccounts();
}
