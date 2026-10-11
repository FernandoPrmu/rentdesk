import { describe, expect, it } from "vitest";

import { assignSchema, raiseSchema, rateSchema, resolveSchema } from "./schemas";
import { raiseRequest, type RequestSnapshot, requestLabel, serviceStep } from "./transitions";

/** The transition functions with a fake rpc: role checks, the notice built for the other side, the rpc arguments. */

const OWNER = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "00000000-0000-4000-8000-000000000002";
const MACHINE = "00000000-0000-4000-8000-000000000003";

function fakeRpc() {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      return { request_id: "r1", status: "NEW", replayed: false, credit_id: null };
    },
  };
}

const request = (over: Partial<RequestSnapshot> = {}): RequestSnapshot => ({
  id: "r1",
  owner_id: OWNER,
  customer_id: CUSTOMER,
  status: "NEW",
  type: "TONER",
  urgency: "URGENT",
  toner_colours: ["CYAN", "MAGENTA"],
  machine_name: "Canon iR C3226 (A-1)",
  customer_name: "Perera Traders",
  ...over,
});

const owner = { kind: "USER" as const, id: OWNER, role: "OWNER" as const };
const customer = { kind: "USER" as const, id: CUSTOMER, role: "CUSTOMER" as const };

describe("raiseRequest (SRV-01, decision 62)", () => {
  it("tells the owner at once, URGENT first, with a link to the request and the urgency in the data", async () => {
    const { rpc, calls } = fakeRpc();
    await raiseRequest(rpc, customer, {
      idempotencyKey: "00000000-0000-4000-8000-0000000000aa",
      machineId: MACHINE,
      ownerId: OWNER,
      type: "TONER",
      urgency: "URGENT",
      description: "Cyan is empty",
      tonerColours: ["CYAN"],
      context: { machine: "Canon iR C3226 (A-1)", customer: "Perera Traders" },
    });
    const [fn, args] = calls[0];
    expect(fn).toBe("rpc_raise_service_request");
    expect(args.p_input).toMatchObject({ type: "TONER", urgency: "URGENT", toner_colours: ["CYAN"] });
    expect(args.p_notifications).toEqual([
      {
        user_id: OWNER,
        event: "service.raised",
        channel: "IN_APP",
        title: "URGENT: New service request: Perera Traders",
        body: "Toner (cyan) for Canon iR C3226 (A-1). Cyan is empty",
        link: "/owner/service/{entity_id}",
        data: { urgency: "URGENT", priority: true },
      },
    ]);
  });

  it("only a customer raises a request", async () => {
    const { rpc } = fakeRpc();
    await expect(
      raiseRequest(rpc, owner, {
        idempotencyKey: "00000000-0000-4000-8000-0000000000aa",
        machineId: MACHINE,
        ownerId: OWNER,
        type: "OTHER",
        urgency: "LOW",
        description: "x",
        tonerColours: [],
        context: { machine: "M", customer: "C" },
      }),
    ).rejects.toThrow(/Only a customer/);
  });
});

describe("serviceStep (SRV-03..05)", () => {
  it("each owner step tells the customer; the customer's steps tell the owner", async () => {
    const { rpc, calls } = fakeRpc();
    await serviceStep(rpc, owner, request(), { action: "ACKNOWLEDGE" });
    await serviceStep(rpc, owner, request({ status: "ACKNOWLEDGED" }), { action: "ASSIGN", technician: "Nimal", plannedDate: "2026-10-20" });
    await serviceStep(rpc, customer, request({ status: "RESOLVED" }), { action: "REOPEN", reason: "Still jams" });
    const notice = (i: number) => (calls[i][1].p_notifications as { user_id: string; event: string; body: string }[])[0];
    expect(notice(0)).toMatchObject({ user_id: CUSTOMER, event: "service.acknowledged" });
    expect(notice(1)).toMatchObject({ user_id: CUSTOMER, event: "service.assigned", body: expect.stringContaining("Nimal will handle") });
    expect(notice(1).body).toContain("Planned visit: 20 Oct 2026");
    expect(notice(2)).toMatchObject({ user_id: OWNER, event: "service.reopened", body: expect.stringContaining("Reason: Still jams") });
    expect(calls[1][1]).toMatchObject({ p_action: "ASSIGN", p_input: { technician: "Nimal", planned_date: "2026-10-20", note: null } });
  });

  it("the resolve notice names a charge and a discount; a discount is for breakdowns only", async () => {
    const { rpc, calls } = fakeRpc();
    await serviceStep(rpc, owner, request({ status: "IN_PROGRESS", type: "BREAKDOWN", toner_colours: [] }), {
      action: "RESOLVE",
      workDone: "Fuser replaced",
      costCents: 600_000,
      charge: { amountCents: 150_000, description: "Fuser (damaged)" },
      discount: { amountCents: 50_000, description: "3 days down" },
    });
    const body = (calls[0][1].p_notifications as { body: string }[])[0].body;
    expect(body).toContain("Rs. 1,500 will be added to your next bill (Fuser (damaged)).");
    expect(body).toContain("Rs. 500 discount will be taken off your next bills.");
    expect(body).not.toContain("6,000"); // the owner's own cost is never in a customer's notice
    expect(calls[0][1].p_input).toMatchObject({ cost_cents: 600_000, charge: { amount_cents: 150_000 }, discount: { amount_cents: 50_000 } });
    await expect(
      serviceStep(rpc, owner, request({ status: "IN_PROGRESS" }), { action: "RESOLVE", workDone: "x", discount: { amountCents: 1, description: "y" } }),
    ).rejects.toThrow(/breakdowns only/);
  });

  it("refuses the wrong role, another tenant and steps out of order before calling the database", async () => {
    const { rpc, calls } = fakeRpc();
    await expect(serviceStep(rpc, customer, request(), { action: "ACKNOWLEDGE" })).rejects.toThrow(/Only the rental company/);
    await expect(serviceStep(rpc, { ...owner, id: "00000000-0000-4000-8000-000000000009" }, request(), { action: "ACKNOWLEDGE" })).rejects.toThrow(/another owner/);
    await expect(serviceStep(rpc, owner, request(), { action: "START" })).rejects.toThrow(/cannot be changed/);
    await expect(serviceStep(rpc, customer, request({ status: "RESOLVED" }), { action: "REOPEN", reason: "" })).rejects.toThrow(/still wrong/);
    await expect(serviceStep(rpc, { kind: "SYSTEM" }, request(), { action: "ACKNOWLEDGE" })).rejects.toThrow(/Only the customer and the rental company/);
    expect(calls).toHaveLength(0);
  });

  it("a customer's cancel tells the owner; the owner's cancel tells the customer", async () => {
    const { rpc, calls } = fakeRpc();
    await serviceStep(rpc, customer, request(), { action: "CANCEL", reason: "Works again" });
    await serviceStep(rpc, owner, request({ status: "IN_PROGRESS" }), { action: "CANCEL", reason: "Machine replaced" });
    expect((calls[0][1].p_notifications as { user_id: string; event: string }[])[0]).toMatchObject({ user_id: OWNER, event: "service.cancelled_by_customer" });
    expect((calls[1][1].p_notifications as { user_id: string; event: string }[])[0]).toMatchObject({ user_id: CUSTOMER, event: "service.cancelled" });
  });

  it("labels a request for messages", () => {
    expect(requestLabel({ type: "TONER", toner_colours: ["BLACK"] })).toBe("Toner (black)");
    expect(requestLabel({ type: "SPARE_PART", toner_colours: [] })).toBe("Spare part");
  });
});

describe("form schemas (English only, rupees, required fields)", () => {
  const key = "00000000-0000-4000-8000-0000000000aa";
  it("raise: machine, type and description are required; the urgency defaults to Normal; an empty date is no date", () => {
    const ok = raiseSchema.safeParse({ idempotencyKey: key, machineId: MACHINE, type: "BREAKDOWN", description: "Error E-201", preferredDate: "" });
    expect(ok.success && ok.data).toMatchObject({ urgency: "NORMAL", tonerColours: [], preferredDate: undefined, photoPath: null });
    expect(raiseSchema.safeParse({ idempotencyKey: key, machineId: MACHINE, type: "BREAKDOWN", description: " " }).success).toBe(false);
    expect(raiseSchema.safeParse({ idempotencyKey: key, machineId: MACHINE, type: "BREAKDOWN", description: "ප්‍රශ්නය" }).error?.issues[0].message).toBe("Please use English letters only.");
    expect(raiseSchema.safeParse({ idempotencyKey: key, machineId: MACHINE, description: "x" }).error?.issues[0].message).toBe("Choose what you need");
  });

  it("assign needs a technician; resolve needs the work done and both halves of a charge or a discount", () => {
    expect(assignSchema.safeParse({ technician: "" }).success).toBe(false);
    expect(assignSchema.safeParse({ technician: "Nimal", plannedDate: "" }).data).toMatchObject({ technician: "Nimal", plannedDate: undefined });
    expect(resolveSchema.safeParse({ workDone: "Done", cost: "6,000" }).data).toMatchObject({ cost: 600_000, chargeAmount: null, discountAmount: null });
    expect(resolveSchema.safeParse({ workDone: "" }).success).toBe(false);
    expect(resolveSchema.safeParse({ workDone: "Done", chargeAmount: "1500" }).error?.issues[0].path).toEqual(["chargeDescription"]);
    expect(resolveSchema.safeParse({ workDone: "Done", chargeDescription: "Drum" }).error?.issues[0].path).toEqual(["chargeAmount"]);
    expect(resolveSchema.safeParse({ workDone: "Done", discountAmount: "abc" }).error?.issues[0].message).toMatch(/enter rupees/);
    expect(resolveSchema.safeParse({ workDone: "Done", chargeAmount: "1500", chargeDescription: "Drum" }).data).toMatchObject({ chargeAmount: 150_000 });
  });

  it("rating is 1 to 5 stars", () => {
    expect(rateSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(rateSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(rateSchema.safeParse({ rating: 5, comment: "Great" }).success).toBe(true);
  });
});
