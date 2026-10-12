import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { type Rpc, RpcError } from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

import { type Bucket, deliverDue, type OutboxConfig, type OutboxPorts, type OutboxSummary } from "./outbox";
import { isProductionDeployment } from "./policy";
import { type EmailTransport, fakeTransport, resendTransport, stubTextTransport } from "./transport";

/**
 * Server wiring of the outbox (decision 67): the service-role client, the storage
 * buckets, the transport chosen by the environment, and `kickOutbox()`, which sends
 * what is due right after the current request has finished (Next `after()`), so a
 * response never waits for Resend and a rolled-back change has no row to send.
 */

/** Resend's shared test sender: works only to the Resend account's own address (fine with EMAIL_DEV_REDIRECT). */
const RESEND_TEST_FROM = "onboarding@resend.dev";

let fake: ReturnType<typeof fakeTransport> | null = null;

/** EMAIL_TRANSPORT=fake (tests, e2e) never sends; otherwise Resend when RESEND_API_KEY is set; else none. */
export function emailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport | null {
  if (env.EMAIL_TRANSPORT === "fake") return (fake ??= fakeTransport());
  if (env.EMAIL_TRANSPORT === "none") return null;
  const key = env.RESEND_API_KEY?.trim();
  return key ? resendTransport(key) : null;
}

export function outboxConfig(env: NodeJS.ProcessEnv = process.env): OutboxConfig {
  return {
    appUrl: (env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
    fromAddress: env.EMAIL_FROM?.trim() || RESEND_TEST_FROM,
    production: isProductionDeployment(env),
    devRedirect: env.EMAIL_DEV_REDIRECT?.trim() || null,
    platformReplyTo: env.EMAIL_REPLY_TO?.trim() || null,
  };
}

/** OUTBOX_STATS=1: count what the outbox does, to measure its database load. */
const STATS = { kicks: 0, drains: 0, rpcCalls: 0, claimed: 0, ms: 0 };
const statsOn = () => process.env.OUTBOX_STATS === "1";
function logStats(label: string) {
  if (statsOn()) console.info(`[outbox-stats] ${label} kicks=${STATS.kicks} drains=${STATS.drains} rpc=${STATS.rpcCalls} claimed=${STATS.claimed} ms=${STATS.ms}`);
}

/** The rpc port over supabase-js (no kick: the sender must not wake itself). */
function clientRpc(client: SupabaseClient<Database>): Rpc {
  return async (fn, args) => {
    STATS.rpcCalls += 1;
    const { data, error } = await client.rpc(fn as never, args as never);
    if (error) throw new RpcError(error.code, error.message);
    return data;
  };
}

export function outboxPorts(client: SupabaseClient<Database> = createAdminClient()): OutboxPorts {
  return {
    rpc: clientRpc(client),
    email: emailTransport(),
    text: stubTextTransport(),
    async readFile(bucket: Bucket, path: string) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error) throw new Error(`${bucket}/${path}: ${error.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    config: outboxConfig(),
    log: (line) => console.info(line),
  };
}

/** Sends what is due now (daily job, "after" hook). */
export function deliverNow(options: { now?: () => Date; budgetMs?: number } = {}): Promise<OutboxSummary> {
  return deliverDue(outboxPorts(), { now: options.now, budgetMs: options.budgetMs ?? 20_000 });
}

// One drain at a time per server instance; a kick during a drain makes it run once more,
// so rows committed while it was busy are not left for the daily job.
let running: Promise<void> | null = null;
let again = false;

function drain(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        STATS.drains += 1;
        const t0 = Date.now();
        const s = await deliverNow();
        STATS.ms += Date.now() - t0;
        STATS.claimed += s.claimed;
        logStats("drain");
        if (s.claimed > 0) console.info(`[notifications] sent ${s.sent}, retry ${s.retry}, failed ${s.failed}, skipped ${s.skipped}, waiting ${s.postponed}`);
      } while (again);
    } catch (error) {
      // The rows stay due: the next kick or the daily job sends them.
      console.error("[notifications] outbox:", error instanceof Error ? error.message : error);
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Call after any change that may have queued deliveries. Runs after the response;
 * outside a request (scripts, tests) it does nothing and the daily job sends them.
 */
export function kickOutbox(): void {
  // OUTBOX_KICK=off: send only from the daily job (measurement and an emergency switch).
  if (process.env.OUTBOX_KICK === "off") return;
  STATS.kicks += 1;
  try {
    after(drain);
  } catch {
    // Not inside a request.
  }
}
