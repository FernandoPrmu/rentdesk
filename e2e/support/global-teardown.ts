import { deleteE2eAccounts, deleteE2eMachines, restoreDemoState } from "./demo";

/** Leave the seed accounts as the seed created them. */
export default async function globalTeardown() {
  await restoreDemoState();
  await deleteE2eMachines();
  await deleteE2eAccounts();
}
