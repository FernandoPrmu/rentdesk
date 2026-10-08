import { deleteE2eAccounts, deleteE2eMachines, restoreDemoState } from "./demo";

/** Start every run from the seed state, even if an earlier run was interrupted. */
export default async function globalSetup() {
  await restoreDemoState();
  await deleteE2eMachines();
  await deleteE2eAccounts();
}
