/**
 * npm pre-hook (predev, pretest:e2e, pretest:e2e:gate, pretest:e2e:dev): refuses to start
 * when the environment Next.js would load points at a production database (decision 95).
 * It checks what `next dev` loads and what `next build` / `next start` load (the e2e
 * server), so a stray .env.production.local cannot slip through.
 *
 *   node scripts/guard-not-production.ts "npm run dev"
 */
import { exitIfProduction, nextEnv } from "./lib/production-lock.ts";

const tool = process.argv[2] ?? "this command";
await exitIfProduction(tool, [nextEnv(true), nextEnv(false)]);
