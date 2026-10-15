import { assertNotProduction } from "../../scripts/lib/production-lock.ts";

/**
 * `npm run test:db` checks the production lock first (decision 95): no suite starts
 * when SUPABASE_DB_URL or the Data API in .env.local reach a production database.
 */
export default async function setup() {
  await assertNotProduction("npm run test:db", [process.env]);
}
