import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCorrectedInvoice, type StoredCalculation } from "../../src/lib/billing/dispute.ts";
import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";
import { escalateServiceRequests } from "../../src/lib/cron/daily.ts";
import type { ServiceStatus } from "../../src/lib/service/states.ts";
import * as S from "../../src/lib/service/transitions.ts";
import * as T from "../../src/lib/tickets/transitions.ts";

import { asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { meterContextFromDb, returnPayload } from "./returns";
import { pgRpc } from "./rpc";

/**
 * Service requests (spec 4.9, 7; SRV-01..09, CP-07; decisions 57-62) against the
 * linked dev database, rolled back: raising (idempotent, toner colours, the owner told
 * at once with URGENT / HIGH first), the full lifecycle, "still not fixed", the cancel
 * rules, escalation by urgency through the daily job's own step, the charge on the
 * next invoice and the discount credit, the rating, and RLS on requests, their trail
 * and their photos. Payloads come from the same transition functions as the server.
 *
 * Fixture: customer A1 rents a colour machine (reading waiting for review) and a mono
 * machine (cycle 1 waiting for a reading); A2 and B1 are other customers.
 */

const RS = (rupees: number) => rupees * 100;
const HOUR = 3_600_000;

describe.skipIf(!DB_URL)("service requests (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;
  let rpc: T.Rpc;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    today = (await db.query("select app.colombo_date(now())::text as d")).rows[0].d;
    rpc = pgRpc(db);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as R;

  /**
   * Runs `fn` and then the checks a commit runs (the deferred service-charge trigger,
   * decision 59): SET CONSTRAINTS ... IMMEDIATE fires them now. A failure rolls `fn`
   * back, like a refused request.
   */
  async function committed<R>(fn: () => Promise<R>): Promise<R> {
    await db.query("savepoint commit_check");
    try {
      const result = await fn();
      await db.query("set constraints all immediate");
      await db.query("set constraints all deferred");
      await db.query("release savepoint commit_check");
      return result;
    } catch (error) {
      await db.query("rollback to savepoint commit_check");
      await db.query("set constraints all deferred");
      const { code, message } = error as { code?: string; message: string };
      throw new T.RpcError(code, message);
    }
  }
  const refusal = (fn: () => Promise<unknown>) =>
    committed(fn).then(
      () => null,
      (e: T.RpcError) => ({ code: e.code, message: e.message }),
    );
  const actor = (role: "OWNER" | "CUSTOMER", id: string): T.Actor => ({ kind: "USER", id, role });
  const notified = (userId: string, event: string) => count(db, "select 1 from public.notifications where user_id = $1 and event = $2", [userId, event]);
  const audited = (action: string, entityId: string) => count(db, "select 1 from public.audit_logs where action = $1 and entity_id = $2", [action, entityId]);

  async function snap(id: string): Promise<S.RequestSnapshot> {
    return one(
      `select r.id, r.owner_id, r.customer_id, r.status, r.type, r.urgency, r.toner_colours::text[] as toner_colours,
              m.brand || ' ' || m.model as machine_name, c.name as customer_name
       from public.service_requests r join public.machines m on m.id = r.machine_id join public.customers c on c.id = r.customer_id
       where r.id = $1`,
      [id],
    );
  }
  const statusOf = async (id: string) => (await snap(id)).status as ServiceStatus;
  const rowsOf = (rows: { metadata: Record<string, unknown> }[]) => rows.map((r) => r.metadata);

  type RaiseOptions = Partial<{ key: string; machine: string; type: S.RequestSnapshot["type"]; urgency: S.RequestSnapshot["urgency"]; colours: S.RequestSnapshot["toner_colours"]; photo: string | null; customer: string; owner: string }>;
  function raise(o: RaiseOptions = {}) {
    const customerId = o.customer ?? f.custA1;
    return S.raiseRequest(rpc, actor("CUSTOMER", customerId), {
      idempotencyKey: o.key ?? randomUUID(),
      machineId: o.machine ?? f.machineAColour,
      ownerId: o.owner ?? f.ownerA,
      type: o.type ?? "TONER",
      urgency: o.urgency ?? "NORMAL",
      description: "Cyan and magenta are nearly empty",
      tonerColours: o.colours ?? (o.type && o.type !== "TONER" ? [] : ["CYAN", "MAGENTA"]),
      photo: o.photo ? { storagePath: o.photo, sha256: "c".repeat(64), mimeType: "image/jpeg", sizeBytes: 180_000 } : null,
      context: { machine: "Canon iR C3226", customer: "Customer A1" },
    });
  }
  const step = async (id: string, by: "OWNER" | "CUSTOMER", input: S.StepInput) => {
    const r = await snap(id);
    return S.serviceStep(rpc, actor(by, by === "OWNER" ? r.owner_id : r.customer_id), r, input);
  };
  /** New → In progress, as the owner does it. */
  async function toInProgress(id: string) {
    await step(id, "OWNER", { action: "ACKNOWLEDGE" });
    await step(id, "OWNER", { action: "ASSIGN", technician: "Nimal" });
    await step(id, "OWNER", { action: "START" });
  }
  const trail = async (id: string) =>
    (
      await db.query<{ kind: string; from_status: string | null; to_status: string; note: string | null; changed_by: string | null; metadata: Record<string, unknown> }>(
        "select kind, from_status, to_status, note, changed_by, metadata from public.service_request_history where request_id = $1 order by changed_at, id",
        [id],
      )
    ).rows;

  // ---------------------------------------------------------------------------
  // Raising a request (SRV-01, SRV-02, SRV-06, CP-07; decision 62)
  // ---------------------------------------------------------------------------

  it("the customer raises a toner request with a photo: New, trail, audit, the owner told at once with URGENT first; a retry never doubles it", async () => {
    await isolated(db, async () => {
      const key = randomUUID();
      const photo = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
      const r = await raise({ key, urgency: "URGENT", photo });
      expect(r).toMatchObject({ status: "NEW", replayed: false });
      expect(
        await one("select status, type, urgency, toner_colours::text[] as colours, photo_path, photo_mime, agreement_id from public.service_requests where id = $1", [r.request_id]),
      ).toEqual({ status: "NEW", type: "TONER", urgency: "URGENT", colours: ["CYAN", "MAGENTA"], photo_path: photo, photo_mime: "image/jpeg", agreement_id: f.agrA1Colour });
      expect(await trail(r.request_id)).toEqual([expect.objectContaining({ kind: "STATUS", from_status: null, to_status: "NEW", changed_by: f.custA1 })]);
      expect(await audited("SERVICE_REQUEST_RAISED", r.request_id)).toBe(1);

      // The owner hears of it in the same transaction, the urgency first and in the data.
      const n = await one<{ title: string; body: string; link: string; data: Record<string, unknown>; channel: string; status: string }>(
        "select title, body, link, data, channel, status from public.notifications where user_id = $1 and event = 'service.raised' and entity_id = $2",
        [f.ownerA, r.request_id],
      );
      expect(n.title).toBe("URGENT: New service request: Customer A1");
      expect(n.body).toMatch(/^Toner \(cyan, magenta\) for Canon iR C3226\./);
      expect(n).toMatchObject({ link: `/owner/service/${r.request_id}`, channel: "IN_APP", status: "SENT", data: { urgency: "URGENT", priority: true } });

      // Retried (double tap, lost response): the same request comes back.
      await expect(raise({ key, urgency: "URGENT", photo })).resolves.toMatchObject({ request_id: r.request_id, replayed: true });
      expect(await count(db, "select 1 from public.service_requests where idempotency_key = $1", [key])).toBe(1);
      expect(await notified(f.ownerA, "service.raised")).toBe(1);
      // Another customer cannot replay someone else's key.
      await expect(raise({ key, customer: f.custA2, machine: f.machineAMono2 })).rejects.toThrow(/Idempotency key already used/);
    });
  });

  it("HIGH is highlighted too; NORMAL and LOW are not", async () => {
    await isolated(db, async () => {
      const high = await raise({ urgency: "HIGH" });
      const normal = await raise({ urgency: "NORMAL" });
      const low = await raise({ urgency: "LOW" });
      const title = async (id: string) => (await one<{ title: string }>("select title from public.notifications where entity_id = $1 and event = 'service.raised'", [id])).title;
      expect(await title(high.request_id)).toBe("High priority: New service request: Customer A1");
      expect(await title(normal.request_id)).toBe("New service request: Customer A1");
      expect(await title(low.request_id)).toBe("New service request: Customer A1");
    });
  });

  it("SRV-06 toner colours: a mono machine gets black automatically, a colour machine must name one; other types carry none", async () => {
    await isolated(db, async () => {
      const mono = await raise({ machine: f.machineAMono1, colours: [] });
      expect((await snap(mono.request_id)).toner_colours).toEqual(["BLACK"]);
      await expect(raise({ machine: f.machineAMono1, colours: ["CYAN"] })).rejects.toThrow(/black toner only/);
      await expect(raise({ colours: [] })).rejects.toThrow(/Choose the toner colour/);
      await expect(raise({ type: "BREAKDOWN", colours: ["BLACK"] })).rejects.toThrow(/only for toner requests/);
      const breakdown = await raise({ type: "BREAKDOWN" });
      expect((await snap(breakdown.request_id)).toner_colours).toEqual([]);
    });
  });

  it("a request is only for a machine the customer rents, by the customer, with a photo in their own folder", async () => {
    await isolated(db, async () => {
      await expect(raise({ machine: f.machineAMono2 })).rejects.toMatchObject({ code: "RD404" }); // A2's machine
      await expect(raise({ machine: f.machineASpare })).rejects.toMatchObject({ code: "RD404" }); // not rented
      await expect(raise({ photo: `${f.ownerA}/${f.custA2}/${randomUUID()}.jpg` })).rejects.toThrow(/photo is not valid/);
      // The rpc refuses an owner even when called directly.
      const error = await sqlError(db, "select app.raise_service_request($1, gen_random_uuid(), $2, $3::jsonb, null)", [
        f.ownerA,
        f.machineAColour,
        JSON.stringify({ type: "OTHER", description: "x" }),
      ]);
      expect(error?.code).toBe("RD403");
      // Past preferred dates are refused.
      const past = await sqlError(db, "select app.raise_service_request($1, gen_random_uuid(), $2, $3::jsonb, null)", [
        f.custA1,
        f.machineAColour,
        JSON.stringify({ type: "MAINTENANCE", description: "Yearly service", preferred_date: "2020-01-01" }),
      ]);
      expect(past?.message).toMatch(/preferred date/);
    });
  });

  // ---------------------------------------------------------------------------
  // Workflow (SRV-03..05, SRV-07; decision 57)
  // ---------------------------------------------------------------------------

  it("full lifecycle: acknowledged, assigned (and reassigned), in progress, resolved with work, parts and cost, confirmed by the customer", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "BREAKDOWN", machine: f.machineAMono1 });
      await step(id, "OWNER", { action: "ACKNOWLEDGE", note: "We will call you" });
      await step(id, "OWNER", { action: "ASSIGN", technician: "Nimal Perera", plannedDate: today });
      await step(id, "OWNER", { action: "ASSIGN", technician: "Kamal Silva", plannedDate: today, note: "Nimal is on leave" });
      expect(await statusOf(id)).toBe("ASSIGNED");
      await step(id, "OWNER", { action: "START" });
      await step(id, "OWNER", { action: "NOTE", note: "Waiting for the fuser" });
      await step(id, "OWNER", { action: "RESOLVE", workDone: "Replaced the fuser unit", partsUsed: "Fuser unit FK-1150", costCents: RS(8500) });
      expect(rowsOf(await trail(id)).some((m) => "cost_cents" in m)).toBe(false); // the customer reads the trail
      expect(await one("select work_done, parts_used, cost_cents::int as cost, assigned_to_name, planned_date::text as planned from public.service_requests where id = $1", [id])).toEqual({
        work_done: "Replaced the fuser unit",
        parts_used: "Fuser unit FK-1150",
        cost: RS(8500),
        assigned_to_name: "Kamal Silva",
        planned: today,
      });
      await step(id, "CUSTOMER", { action: "CONFIRM" });
      expect(await one("select status, closed_by from public.service_requests where id = $1", [id])).toEqual({ status: "CLOSED", closed_by: f.custA1 });

      const rows = await trail(id);
      expect(rows.map((r) => `${r.kind}:${r.to_status}`)).toEqual([
        "STATUS:NEW",
        "STATUS:ACKNOWLEDGED",
        "STATUS:ASSIGNED",
        "ASSIGNMENT:ASSIGNED",
        "STATUS:IN_PROGRESS",
        "NOTE:IN_PROGRESS",
        "STATUS:RESOLVED",
        "STATUS:CLOSED",
      ]);
      expect(rows[1]).toMatchObject({ note: "We will call you", changed_by: f.ownerA });
      expect(rows[3]).toMatchObject({ note: "Nimal is on leave", metadata: expect.objectContaining({ technician: "Kamal Silva", previous_technician: "Nimal Perera" }) });
      expect(rows[7]).toMatchObject({ changed_by: f.custA1, metadata: { confirmed_by_customer: true } });

      // Every change audited; the customer told of every owner step (SRV-05), the owner of the confirmation.
      for (const action of ["ACKNOWLEDGE", "ASSIGN", "START", "NOTE", "RESOLVE", "CONFIRM"]) {
        expect(await audited(`SERVICE_REQUEST_${action}`, id), action).toBeGreaterThan(0);
      }
      for (const event of ["service.acknowledged", "service.assigned", "service.updated", "service.started", "service.note", "service.resolved"]) {
        expect(await notified(f.custA1, event), event).toBe(1);
      }
      expect(await notified(f.ownerA, "service.confirmed")).toBe(1);
      // Closed is final.
      await expect(step(id, "OWNER", { action: "NOTE", note: "late" })).rejects.toThrow(/closed/);
    });
  });

  it("steps out of order, by the wrong role or another tenant are refused (also by the database)", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "OTHER" });
      await expect(step(id, "OWNER", { action: "START" })).rejects.toThrow(/cannot be changed this way/);
      await expect(step(id, "CUSTOMER", { action: "ACKNOWLEDGE" })).rejects.toThrow(/Only the rental company/);
      const r = await snap(id);
      await expect(S.serviceStep(rpc, actor("OWNER", f.ownerB), r, { action: "ACKNOWLEDGE" })).rejects.toThrow(/another owner/);
      // Straight to the rpc: the same rules.
      const skip = await sqlError(db, "select app.service_request_action($1, $2, 'RESOLVE', $3::jsonb)", [id, f.ownerA, JSON.stringify({ work_done: "x" })]);
      expect(skip?.code).toBe("RD409");
      const other = await sqlError(db, "select app.service_request_action($1, $2, 'ACKNOWLEDGE', '{}'::jsonb)", [id, f.ownerB]);
      expect(other?.code).toBe("RD403");
      const customer = await sqlError(db, "select app.service_request_action($1, $2, 'ACKNOWLEDGE', '{}'::jsonb)", [id, f.custA1]);
      expect(customer?.code).toBe("RD403");
    });
  });

  it("'still not fixed' takes a resolved request back to In progress with the reason; the owner resolves again and closes it", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "BREAKDOWN", urgency: "HIGH" });
      await toInProgress(id);
      await step(id, "OWNER", { action: "RESOLVE", workDone: "Cleaned the rollers" });
      await expect(S.serviceStep(rpc, actor("CUSTOMER", f.custA1), await snap(id), { action: "REOPEN", reason: "" })).rejects.toThrow(/still wrong/);
      await step(id, "CUSTOMER", { action: "REOPEN", reason: "Paper still jams on tray 2" });
      expect(await one("select status, reopen_count, resolved_at from public.service_requests where id = $1", [id])).toEqual({ status: "IN_PROGRESS", reopen_count: 1, resolved_at: null });
      const last = (await trail(id)).at(-1);
      expect(last).toMatchObject({ from_status: "RESOLVED", to_status: "IN_PROGRESS", note: "Paper still jams on tray 2", changed_by: f.custA1, metadata: { reopen_no: 1 } });
      const n = await one<{ title: string; body: string }>("select title, body from public.notifications where user_id = $1 and event = 'service.reopened'", [f.ownerA]);
      expect(n.title).toBe("High priority: Still not fixed: Customer A1");
      expect(n.body).toMatch(/Reason: Paper still jams on tray 2/);
      expect(await audited("SERVICE_REQUEST_REOPEN", id)).toBe(1);

      await step(id, "OWNER", { action: "RESOLVE", workDone: "Replaced the tray 2 pickup roller" });
      await step(id, "OWNER", { action: "CLOSE", note: "Customer phoned to say it works" });
      expect(await one("select status, closed_by, work_done from public.service_requests where id = $1", [id])).toEqual({
        status: "CLOSED",
        closed_by: f.ownerA,
        work_done: "Replaced the tray 2 pickup roller",
      });
      expect(await notified(f.custA1, "service.closed")).toBe(1);
    });
  });

  it("cancel: the customer only while New, the owner at any open step; a reason is always needed", async () => {
    await isolated(db, async () => {
      const mine = await raise({ type: "OTHER" });
      await expect(step(mine.request_id, "CUSTOMER", { action: "CANCEL", reason: " " })).rejects.toThrow(/reason/);
      await step(mine.request_id, "CUSTOMER", { action: "CANCEL", reason: "Fixed it myself" });
      expect(await one("select status, cancel_reason, cancelled_by from public.service_requests where id = $1", [mine.request_id])).toEqual({
        status: "CANCELLED",
        cancel_reason: "Fixed it myself",
        cancelled_by: f.custA1,
      });
      expect(await notified(f.ownerA, "service.cancelled_by_customer")).toBe(1);

      const acked = await raise({ type: "OTHER" });
      await step(acked.request_id, "OWNER", { action: "ACKNOWLEDGE" });
      await expect(step(acked.request_id, "CUSTOMER", { action: "CANCEL", reason: "No longer needed" })).rejects.toThrow(/already working/);
      const direct = await sqlError(db, "select app.service_request_action($1, $2, 'CANCEL', $3::jsonb)", [acked.request_id, f.custA1, JSON.stringify({ reason: "x" })]);
      expect(direct?.message).toMatch(/NOT_NEW/);

      const working = await raise({ type: "BREAKDOWN" });
      await toInProgress(working.request_id);
      await step(working.request_id, "OWNER", { action: "CANCEL", reason: "Machine is being replaced" });
      expect(await statusOf(working.request_id)).toBe("CANCELLED");
      expect(await notified(f.custA1, "service.cancelled")).toBe(1);
      expect(await audited("SERVICE_REQUEST_CANCEL", working.request_id)).toBe(1);
      await expect(step(working.request_id, "OWNER", { action: "CANCEL", reason: "again" })).rejects.toThrow(/cancelled/);
    });
  });

  // ---------------------------------------------------------------------------
  // Escalation (SRV-08, spec 7.3; decision 61)
  // ---------------------------------------------------------------------------

  it("escalation by urgency: URGENT and HIGH after 4 h (owner) and 8 h (admin), NORMAL and LOW after 24 h and 48 h; idempotent; acknowledged or suspended ones wait", async () => {
    await isolated(db, async () => {
      const created = new Date(Date.now() - 400 * HOUR); // far from the seed's own requests
      const urgent = (await raise({ urgency: "URGENT", type: "BREAKDOWN" })).request_id;
      const high = (await raise({ urgency: "HIGH", type: "BREAKDOWN" })).request_id;
      const normal = (await raise({ urgency: "NORMAL", type: "OTHER" })).request_id;
      const low = (await raise({ urgency: "LOW", type: "OTHER" })).request_id;
      const acked = (await raise({ urgency: "URGENT", type: "BREAKDOWN" })).request_id;
      await step(acked, "OWNER", { action: "ACKNOWLEDGE" });
      await db.query("update public.service_requests set created_at = $2 where id = any($1::uuid[])", [[urgent, high, normal, low, acked], created]);

      const ours = [urgent, high, normal, low, acked];
      const level = async (id: string) => (await one<{ l: number }>("select escalation_level as l from public.service_requests where id = $1", [id])).l;
      const run = async (hours: number) => {
        const counts = { serviceEscalated: 0, skipped: 0 };
        const errors: { id?: string }[] = [];
        await escalateServiceRequests(rpc, new Date(created.getTime() + hours * HOUR), [f.admin], 50, counts, (e) => errors.push(e));
        expect(errors.filter((e) => e.id && ours.includes(e.id))).toEqual([]);
        return counts;
      };

      await run(2); // nothing due yet
      expect([await level(urgent), await level(high), await level(normal), await level(low)]).toEqual([0, 0, 0, 0]);

      await run(5); // past 4 h: URGENT and HIGH re-notify the owner
      expect([await level(urgent), await level(high), await level(normal), await level(low)]).toEqual([1, 1, 0, 0]);
      const owner = await one<{ title: string }>("select title from public.notifications where entity_id = $1 and event = 'service.escalated_owner'", [urgent]);
      expect(owner.title).toBe("URGENT: Service request waiting 5 hours: Customer A1");
      expect(await count(db, "select 1 from public.notifications where entity_id = $1 and event = 'service.escalated_admin'", [urgent])).toBe(0);

      await run(5); // same time again: nothing new
      expect(await count(db, "select 1 from public.notifications where entity_id = $1 and event = 'service.escalated_owner'", [urgent])).toBe(1);

      await run(9); // past 8 h: the admin is alerted for URGENT and HIGH
      expect([await level(urgent), await level(high), await level(normal), await level(low)]).toEqual([2, 2, 0, 0]);
      expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'service.escalated_admin' and entity_id = any($2::uuid[])", [f.admin, [urgent, high]])).toBe(2);
      expect(await audited("SERVICE_REQUEST_ESCALATED", urgent)).toBe(2);
      expect((await trail(urgent)).filter((r) => r.kind === "ESCALATION").map((r) => r.metadata)).toEqual([{ level: 1 }, { level: 2 }]);

      await run(25); // NORMAL and LOW: the owner after 24 h
      expect([await level(normal), await level(low)]).toEqual([1, 1]);
      // Suspended customer: their requests wait (rule 24); the 48 h admin step does not fire.
      await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.custA1]);
      await run(60);
      expect([await level(normal), await level(low)]).toEqual([1, 1]);
      await db.query("update public.profiles set status = 'ACTIVE' where id = $1", [f.custA1]);
      await run(60); // a missed day: straight to the admin level
      expect([await level(normal), await level(low)]).toEqual([2, 2]);

      expect(await level(acked)).toBe(0); // acknowledged in time: never escalated
      // Compare-and-set: the rpc skips a request already at the level or acknowledged.
      expect(await rpc("rpc_escalate_service_request", { p_request_id: urgent, p_level: 2, p_now: new Date().toISOString(), p_reason: "x" })).toMatchObject({ skipped: true });
      expect(await rpc("rpc_escalate_service_request", { p_request_id: acked, p_level: 1, p_now: new Date().toISOString(), p_reason: "x" })).toMatchObject({ skipped: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Charge on the next bill, discount credit (decisions 59-60)
  // ---------------------------------------------------------------------------

  it("a charge goes on the agreement's next invoice as an ADJUSTMENT line; a draft holds it, a rejected draft frees it, a bill without it is refused", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "SPARE_PART", machine: f.machineAMono1 });
      await toInProgress(id);
      await step(id, "OWNER", {
        action: "RESOLVE",
        workDone: "Replaced the drum",
        costCents: RS(6000),
        charge: { amountCents: RS(1500), description: "Drum unit (damaged by staples)" },
      });
      expect(await notified(f.custA1, "service.resolved")).toBe(1);
      expect((await one<{ body: string }>("select body from public.notifications where user_id = $1 and event = 'service.resolved'", [f.custA1])).body).toMatch(
        /Rs\. 1,500 will be added to your next bill/,
      );
      const free = async () => (await one<{ c: { id: string }[] }>("select app.service_charges_free($1, null) as c", [f.agrA1Mono])).c.map((c) => c.id);
      expect(await free()).toEqual([id]);

      // A reading built without the charge is refused when it commits.
      const context = await meterContextFromDb(db, f.tickets.a1Mono);
      expect(context.serviceCharges).toEqual([{ id, description: "Drum unit (damaged by staples)", amountCents: RS(1500) }]);
      const without = buildMeterSubmission({ ...context, serviceCharges: [] }, { BW: 6000 });
      const submit = (s: typeof without) =>
        refusal(() =>
          db.query(
            `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days', null, $6)`,
            [f.tickets.a1Mono, f.custA1, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` }), JSON.stringify(s.invoice), s.anomalyFlag],
          ),
        );
      expect((await submit(without))?.message).toMatch(/SERVICE_CHARGES_CHANGED/);

      // With it: Rs. 5,000 commitment + Rs. 1,500 charge (1,000 copies are within the 2,000 included).
      const withCharge = buildMeterSubmission(context, { BW: 6000 });
      expect(await submit(withCharge)).toBeNull();
      const draft = await one<{ id: string; total: number; status: string }>(
        "select i.id, i.total_cents::int as total, i.status from public.invoices i join public.billing_cycle_tickets t on t.current_invoice_id = i.id where t.id = $1",
        [f.tickets.a1Mono],
      );
      expect(draft).toMatchObject({ total: RS(6500), status: "DRAFT" });
      expect(await one("select line_type, description, amount_cents::int as amount from public.invoice_lines where invoice_id = $1 and line_type = 'ADJUSTMENT'", [draft.id])).toEqual({
        line_type: "ADJUSTMENT",
        description: "Drum unit (damaged by staples)",
        amount: RS(1500),
      });
      expect(await free()).toEqual([]); // the draft holds it
      // The request cannot be cancelled now: its charge is on a bill.
      await expect(step(id, "OWNER", { action: "CANCEL", reason: "Wrong request" })).rejects.toThrow(/CHARGE_BILLED|on bill/);

      // Rejected: the charge waits for the next reading again.
      const sub = await one<{ id: string }>("select id from public.meter_submissions where invoice_id = $1", [draft.id]);
      await committed(() =>
        db.query("select app.reject_meter_submission($1, $2, $3, 'Photo is blurred', now() + interval '5 days', now() + interval '7 days')", [
          f.tickets.a1Mono,
          sub.id,
          f.ownerA,
        ]),
      );
      expect(await free()).toEqual([id]);

      // The final invoice of a return bills it too (checked like a commit).
      const { payload, submission } = await returnPayload(db, f.agrA1Mono, today, { closing: { bw: 6000 } });
      expect(submission?.invoice.lines.find((l) => l.line_type === "ADJUSTMENT")).toMatchObject({ amount_cents: RS(1500) });
      await committed(() => db.query("select public.rpc_return_machine($1, $2, $3::jsonb, $4::date)", [f.ownerA, f.agrA1Mono, JSON.stringify(payload), today]));
      expect(await free()).toEqual([]);
    });
  });

  it("a confirmed bill keeps its charge; correcting it carries the charge to the new bill; a charge is refused once the machine is returned", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "SPARE_PART", machine: f.machineAMono1 });
      await toInProgress(id);
      await step(id, "OWNER", { action: "RESOLVE", workDone: "New toner hopper", charge: { amountCents: RS(2000), description: "Toner hopper" } });
      const s = buildMeterSubmission(await meterContextFromDb(db, f.tickets.a1Mono), { BW: 5500 });
      const { rows } = await committed(() =>
        db.query(
          `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days', null, $6) as r`,
          [f.tickets.a1Mono, f.custA1, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` }), JSON.stringify(s.invoice), s.anomalyFlag],
        ),
      );
      await committed(() =>
        db.query("select app.confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '7 days')", [f.tickets.a1Mono, rows[0].r.submission_id, f.ownerA]),
      );
      const issued = await one<{ id: string; invoice_no: string; total: number; calculation: StoredCalculation }>(
        "select id, invoice_no, total_cents::int as total, calculation from public.invoices where id = $1",
        [rows[0].r.invoice_id],
      );
      expect(issued.total).toBe(RS(7000));

      // Cancel and reissue (decision 49): the corrected bill carries the charge; leaving it out is refused.
      const ticket = await one<T.TicketSnapshot>("select id, owner_id, customer_id, cycle_no, status, status_before_overdue from public.billing_cycle_tickets where id = $1", [f.tickets.a1Mono]);
      const original = { invoiceNo: issued.invoice_no, type: "NORMAL" as const, totalCents: issued.total, amountPaidCents: 0, calculation: issued.calculation };
      const built = buildCorrectedInvoice(original, { readings: null, adjustments: [{ description: "Goodwill", amountCents: -RS(500) }], credits: [], paidCreditId: null });
      expect(built.invoice.lines.filter((l) => l.line_type === "ADJUSTMENT").map((l) => l.amount_cents)).toEqual([-RS(500), RS(2000)]);
      const correct = (invoice: typeof built.invoice) =>
        T.correctInvoice(rpc, actor("OWNER", f.ownerA), ticket, {
          invoiceId: issued.id,
          reason: "Goodwill",
          readings: null,
          invoice,
          paidCreditId: null,
          dueDate: today,
          stageDueAt: new Date(Date.now() + 2 * 86_400_000),
        });
      const dropped = buildCorrectedInvoice({ ...original, calculation: { ...issued.calculation, service_charges: [] } }, { readings: null, adjustments: [{ description: "Goodwill", amountCents: -RS(500) }], credits: [], paidCreditId: null });
      expect((await refusal(() => correct(dropped.invoice)))?.message).toMatch(/SERVICE_CHARGES_CHANGED/);
      const result = await committed(() => correct(built.invoice));
      expect(await one("select total_cents::int as total from public.invoices where id = $1", [result.invoice_id])).toEqual({ total: RS(6500) });
      expect(await one<{ c: unknown[] }>("select app.service_charges_free($1, null) as c", [f.agrA1Mono])).toEqual({ c: [] });

      // Machine returned: a new charge on that agreement has no bill to go on.
      const { payload } = await returnPayload(db, f.agrA1Mono, today, { closing: { bw: 5500 } });
      await committed(() => db.query("select public.rpc_return_machine($1, $2, $3::jsonb, $4::date)", [f.ownerA, f.agrA1Mono, JSON.stringify(payload), today]));
      const other = await one<{ id: string }>(
        `insert into public.service_requests (owner_id, customer_id, machine_id, agreement_id, type, description, status, created_by)
         values ($1, $2, $3, $4, 'SPARE_PART', 'Late part', 'IN_PROGRESS', $2) returning id`,
        [f.ownerA, f.custA1, f.machineAMono1, f.agrA1Mono],
      );
      await expect(step(other.id, "OWNER", { action: "RESOLVE", workDone: "Fitted", charge: { amountCents: RS(100), description: "Part" } })).rejects.toThrow(/AGREEMENT_ENDED|returned/);
      // Resolving without a charge still works.
      await step(other.id, "OWNER", { action: "RESOLVE", workDone: "Fitted" });
    });
  });

  it("a breakdown discount is a customer credit taken off the next bill; other types and a second discount are refused", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "BREAKDOWN", machine: f.machineAMono1 });
      await toInProgress(id);
      const r = await step(id, "OWNER", { action: "RESOLVE", workDone: "Replaced the motor", discount: { amountCents: RS(1000), description: "Machine down for 3 days" } });
      expect(r.credit_id).toBeTruthy();
      expect(await one("select kind, amount_cents::int as amount, reason, service_request_id, status from public.credits where id = $1", [r.credit_id])).toEqual({
        kind: "SERVICE_DISCOUNT",
        amount: RS(1000),
        reason: "Service discount: Machine down for 3 days",
        service_request_id: id,
        status: "AVAILABLE",
      });
      const context = await meterContextFromDb(db, f.tickets.a1Mono);
      const s = buildMeterSubmission(context, { BW: 6000 });
      expect(s.invoice.lines.find((l) => l.line_type === "CREDIT")).toMatchObject({ amount_cents: -RS(1000), credit_id: r.credit_id });
      expect(s.invoice.total_cents).toBe(RS(4000));

      const toner = await raise({ type: "TONER", machine: f.machineAMono1, colours: [] });
      await toInProgress(toner.request_id);
      await expect(step(toner.request_id, "OWNER", { action: "RESOLVE", workDone: "x", discount: { amountCents: 100, description: "y" } })).rejects.toThrow(/breakdowns only/);
      const second = await sqlError(db, "select app.service_request_action($1, $2, 'RESOLVE', $3::jsonb)", [
        toner.request_id,
        f.ownerA,
        JSON.stringify({ work_done: "x", discount: { amount_cents: 100, description: "y" } }),
      ]);
      expect(second?.message).toMatch(/breakdowns only/);
    });
  });

  // ---------------------------------------------------------------------------
  // Rating (SRV-09)
  // ---------------------------------------------------------------------------

  it("rating: only after Closed, only by that customer, once, 1 to 5 stars", async () => {
    await isolated(db, async () => {
      const { request_id: id } = await raise({ type: "MAINTENANCE" });
      const rateSql = (by: string, rating: number) => sqlError(db, "select app.rate_service_request($1, $2, $3, 'Quick and friendly')", [id, by, rating]);
      expect((await rateSql(f.custA1, 5))?.message).toMatch(/NOT_CLOSED/);
      await toInProgress(id);
      await step(id, "OWNER", { action: "RESOLVE", workDone: "Cleaned and serviced" });
      await step(id, "CUSTOMER", { action: "CONFIRM" });
      expect((await rateSql(f.custA2, 5))?.code).toBe("RD403");
      expect((await rateSql(f.ownerA, 5))?.code).toBe("RD403");
      expect((await rateSql(f.custA1, 6))?.code).toBe("RD400");
      await S.rateRequest(rpc, actor("CUSTOMER", f.custA1), await snap(id), { rating: 4, comment: "Quick and friendly" });
      expect(await one("select rating, rating_comment, rated_at is not null as rated from public.service_requests where id = $1", [id])).toEqual({
        rating: 4,
        rating_comment: "Quick and friendly",
        rated: true,
      });
      expect((await rateSql(f.custA1, 5))?.message).toMatch(/ALREADY_RATED/);
      expect(await notified(f.ownerA, "service.rated")).toBe(1);
      expect(await audited("SERVICE_REQUEST_RATED", id)).toBe(1);
      expect((await trail(id)).at(-1)).toMatchObject({ kind: "RATING", metadata: { rating: 4 } });
    });
  });

  // ---------------------------------------------------------------------------
  // RLS: requests, trail and photos (AUTH-07, CLAUDE.md rule 6)
  // ---------------------------------------------------------------------------

  it("RLS: another customer or owner sees neither the request, its trail nor its photo; an unsent photo stays private", async () => {
    await isolated(db, async () => {
      const photo = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
      const unsent = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
      await db.query("insert into storage.objects (bucket_id, name) values ('service-photos', $1), ('service-photos', $2)", [photo, unsent]);
      const { request_id: id } = await raise({ photo });
      await step(id, "OWNER", { action: "ACKNOWLEDGE" });

      const sees = async (userId: string) => {
        await asUser(db, userId);
        const r = {
          request: await count(db, "select 1 from public.service_requests where id = $1", [id]),
          trail: await count(db, "select 1 from public.service_request_history where request_id = $1", [id]),
          photo: await count(db, "select 1 from storage.objects where bucket_id = 'service-photos' and name = $1", [photo]),
          unsent: await count(db, "select 1 from storage.objects where bucket_id = 'service-photos' and name = $1", [unsent]),
        };
        await asPostgres(db);
        return r;
      };
      expect(await sees(f.custA1)).toEqual({ request: 1, trail: 2, photo: 1, unsent: 1 });
      expect(await sees(f.ownerA)).toEqual({ request: 1, trail: 2, photo: 1, unsent: 0 });
      expect(await sees(f.admin)).toEqual({ request: 1, trail: 2, photo: 1, unsent: 0 });
      expect(await sees(f.custA2)).toEqual({ request: 0, trail: 0, photo: 0, unsent: 0 });
      expect(await sees(f.ownerB)).toEqual({ request: 0, trail: 0, photo: 0, unsent: 0 });

      // Uploads: only into the customer's own folder; owners and others cannot write.
      const upload = async (userId: string, name: string) => {
        await asUser(db, userId);
        const e = await sqlError(db, "insert into storage.objects (bucket_id, name) values ('service-photos', $1)", [name]);
        await asPostgres(db);
        return e?.code ?? null;
      };
      expect(await upload(f.custA1, `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`)).toBeNull();
      expect(await upload(f.custA2, `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`)).toBe("42501");
      expect(await upload(f.ownerA, `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`)).toBe("42501");

      // Photos never sent with a request are purged after 2 days; a sent one never is.
      const old = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
      await db.query("insert into storage.objects (bucket_id, name, created_at) values ('service-photos', $1, now() - interval '3 days')", [old]);
      await db.query("update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'service-photos' and name = $1", [photo]);
      const orphans = (await one<{ r: string[] }>("select app.cron_orphan_service_photos(now(), 500) as r")).r;
      expect(orphans).toContain(old);
      expect(orphans).not.toContain(photo);

      // Clients cannot write requests directly, nor read the owner's own cost (column grant);
      // the service role reads every new column.
      await asUser(db, f.custA1);
      expect((await sqlError(db, "update public.service_requests set status = 'CLOSED' where id = $1", [id]))?.code).toBe("42501");
      expect((await sqlError(db, "select cost_cents from public.service_requests where id = $1", [id]))?.code).toBe("42501");
      expect(await count(db, "select id, status, charge_cents, work_done from public.service_requests where id = $1", [id])).toBe(1);
      await asUser(db, f.ownerA);
      expect((await sqlError(db, "select cost_cents from public.service_requests where id = $1", [id]))?.code).toBe("42501");
      await asPostgres(db);
      await asService(db);
      expect(
        await count(db, "select photo_path, charge_cents, reopen_count, rated_at, escalated_at, cancel_reason from public.service_requests where id = $1", [id]),
      ).toBe(1);
      expect(await count(db, "select kind, metadata from public.service_request_history where request_id = $1", [id])).toBe(2);
      await asPostgres(db);
    });
  });
});
