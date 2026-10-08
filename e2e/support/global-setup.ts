import { restoreDemoState } from "./demo";

/** Start every run from the seed state, even if an earlier run was interrupted. */
export default async function globalSetup() {
  await restoreDemoState();
}
