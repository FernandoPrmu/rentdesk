import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { Actor, Rpc } from "../../src/lib/tickets/transitions.ts";
import { raiseRequest, type RequestSnapshot, serviceStep } from "../../src/lib/service/transitions.ts";
import type { Database } from "../../src/types/db";

/**
 * Service request steps the test does not drive through the screens, through the
 * same transition functions and rpc wrappers as the app, with the service role.
 */

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A breakdown on the customer's machine, taken by the owner to Resolved (waiting for the customer's answer). */
export async function resolvedBreakdown(ownerId: string, customerId: string, machineId: string): Promise<string> {
  const db = service();
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await db.rpc(fn as never, args as never);
    if (error) throw new Error(`e2e ${fn}: ${error.message}`);
    return data;
  };
  const customer: Actor = { kind: "USER", id: customerId, role: "CUSTOMER" };
  const owner: Actor = { kind: "USER", id: ownerId, role: "OWNER" };
  const raised = await raiseRequest(rpc, customer, {
    idempotencyKey: randomUUID(),
    machineId,
    ownerId,
    type: "BREAKDOWN",
    urgency: "NORMAL",
    description: "Paper jams in tray 2",
    tonerColours: [],
    context: { machine: "E2E machine", customer: "E2E customer" },
  });
  const snapshot = async (): Promise<RequestSnapshot> => {
    const { data, error } = await db.from("service_requests").select("id, owner_id, customer_id, status, type, urgency, toner_colours").eq("id", raised.request_id).single();
    if (error) throw new Error(`e2e service request: ${error.message}`);
    return { ...(data as Omit<RequestSnapshot, "machine_name" | "customer_name">), machine_name: "E2E machine", customer_name: "E2E customer" };
  };
  await serviceStep(rpc, owner, await snapshot(), { action: "ACKNOWLEDGE" });
  await serviceStep(rpc, owner, await snapshot(), { action: "ASSIGN", technician: "Kamal Silva" });
  await serviceStep(rpc, owner, await snapshot(), { action: "START" });
  await serviceStep(rpc, owner, await snapshot(), { action: "RESOLVE", workDone: "Cleaned the pickup roller" });
  return raised.request_id;
}
