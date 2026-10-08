import { restoreDemoState } from "./demo";

/** Leave the seed accounts as the seed created them. */
export default async function globalTeardown() {
  await restoreDemoState();
}
