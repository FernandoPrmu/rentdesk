import { describe, expect, it } from "vitest";

import { type DeliveryRow, deliverDue, type OutboxPorts, PDF_WAIT_MS, sendEmail } from "./outbox";
import type { Quota } from "./policy";
import { fakeTransport, stubTextTransport } from "./transport";

/**
 * The sender with an in-memory database port: what it claims (the allowance from
 * the quota), how it renders, and what it records. The real SQL is covered by
 * supabase/tests/notifications.db.test.ts.
 */

const NOW = new Date("2026-10-11T10:00:00Z");

function row(over: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: "d1",
    token: "t1",
    channel: "EMAIL",
    event: "invoice.issued",
    category: "ESSENTIAL",
    attempts: 0,
    created_at: NOW.toISOString(),
    recipient: "nimal@example.lk",
    user_id: "u1",
    owner_id: "o1",
    role: "CUSTOMER",
    recipient_name: "Nimal Perera",
    title: "New bill: Rs. 12,800",
    body: "Bill INV-000123 for Canon is due on 18 Oct 2026.",
    link: "/customer/tickets/1",
    data: { vars: { invoice_no: "INV-000123", amount: "Rs. 12,800", machine: "Canon", due_date: "18 Oct 2026" } },
    company: { name: "Lanka Copiers", email: "accounts@lanka.lk", logo_path: "o1/logos/abc.png" },
    template: null,
    attachment: { kind: "INVOICE", number: "INV-000123", status: "READY", path: "o1/i1/v1.pdf" },
    ...over,
  };
}

function setup(rows: DeliveryRow[], options: { quota?: Partial<Quota>; production?: boolean; redirect?: string | null; due?: boolean; fromConfigured?: boolean } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const recorded: Record<string, unknown>[] = [];
  let batch = [...rows];
  const transport = fakeTransport();
  const ports: OutboxPorts = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "rpc_outbox_begin") return options.due === false ? null : "lease-1";
      if (fn === "rpc_outbox_end") return null;
      if (fn === "rpc_email_quota") return { sent_today: 0, sent_month: 0, daily_limit: 100, monthly_limit: 3000, reserve: 20, max_attempts: 5, ...options.quota };
      if (fn === "rpc_claim_deliveries") {
        const out = batch;
        batch = [];
        return out;
      }
      if (fn === "rpc_record_delivery_result") {
        recorded.push(args);
        return { status: args.p_outcome };
      }
      throw new Error(fn);
    },
    email: transport,
    text: stubTextTransport(() => {}),
    readFile: async (bucket, path) => new TextEncoder().encode(`${bucket}:${path}`),
    config: { appUrl: "https://app.test", fromAddress: "notify@app.test", production: options.production ?? true, devRedirect: options.redirect ?? null, fromConfigured: options.fromConfigured },
  };
  return { ports, calls, recorded, transport };
}

describe("deliverDue (NOT-02)", () => {
  it("nothing due (or another sender busy): one call, nothing claimed, no lease to give back", async () => {
    const { ports, calls } = setup([row()], { due: false });
    expect(await deliverDue(ports, { now: () => NOW })).toMatchObject({ claimed: 0, idle: true });
    expect(calls.map((c) => c.fn)).toEqual(["rpc_outbox_begin"]);
  });

  it("takes the sender lease first and always gives it back", async () => {
    const { ports, calls } = setup([row()]);
    ports.email = fakeTransport({ fail: () => { throw new Error("transport crashed"); } });
    await deliverDue(ports, { now: () => NOW });
    const fns = calls.map((c) => c.fn);
    expect(fns[0]).toBe("rpc_outbox_begin");
    expect(fns.at(-1)).toBe("rpc_outbox_end");
    expect(calls.at(-1)?.args).toEqual({ p_token: "lease-1" });
  });

  it("sends the bill with its PDF and the company's logo, from the company, replying to the company", async () => {
    const { ports, recorded, transport } = setup([row()]);
    const s = await deliverDue(ports, { now: () => NOW });
    expect(s).toMatchObject({ claimed: 1, sent: 1 });
    const [m] = transport.sent;
    expect(m).toMatchObject({
      from: "Lanka Copiers via RentDesk <notify@app.test>",
      to: "nimal@example.lk",
      replyTo: "accounts@lanka.lk",
      subject: "Your bill INV-000123: Rs. 12,800",
      idempotencyKey: "delivery-d1",
    });
    expect(m.attachments.map((a) => [a.filename, a.contentId ?? null])).toEqual([
      ["Bill-INV-000123.pdf", null],
      ["logo.png", "company-logo"],
    ]);
    expect(m.text).toContain("Your bill INV-000123 for Canon is ready: Rs. 12,800, due on 18 Oct 2026.");
    expect(m.text).toContain("Open in RentDesk: https://app.test/customer/tickets/1");
    expect(recorded[0]).toMatchObject({ p_id: "d1", p_token: "t1", p_outcome: "SENT", p_provider: "fake", p_sent_to: "nimal@example.lk" });
  });

  it("claims with the allowance from the quota", async () => {
    const { ports, calls } = setup([], { quota: { sent_today: 85 } });
    const s = await deliverDue(ports, { now: () => NOW, batch: 10 });
    expect(calls.find((c) => c.fn === "rpc_claim_deliveries")?.args).toMatchObject({ p_email_limit: 10, p_essential_only: true });
    expect(s.limited).toBe(true);
  });

  it("waits for a PDF still being made, then sends without it after a day", async () => {
    const pending = row({ attachment: { kind: "INVOICE", number: "INV-1", status: "PENDING", path: null } });
    const first = setup([pending]);
    expect(await deliverDue(first.ports, { now: () => NOW })).toMatchObject({ postponed: 1, sent: 0 });
    expect(first.recorded[0]).toMatchObject({ p_outcome: "POSTPONE", p_next_attempt_at: "2026-10-11T10:10:00.000Z" });

    const late = setup([{ ...pending, created_at: new Date(NOW.getTime() - PDF_WAIT_MS - 1).toISOString() }]);
    await deliverDue(late.ports, { now: () => NOW });
    expect(late.transport.sent[0].attachments.map((a) => a.filename)).toEqual(["logo.png"]);
    expect(late.transport.sent[0].text).toContain("The PDF is not attached; you can download it in RentDesk.");
  });

  it("outside production: redirected and marked, or skipped when no redirect is set", async () => {
    const dev = setup([row()], { production: false, redirect: "me@dev.lk" });
    await deliverDue(dev.ports, { now: () => NOW });
    expect(dev.transport.sent[0]).toMatchObject({ to: "me@dev.lk", subject: "[DEV] Your bill INV-000123: Rs. 12,800" });
    expect(dev.transport.sent[0].text).toContain("In production this email would go to nimal@example.lk.");
    expect(dev.recorded[0]).toMatchObject({ p_outcome: "SENT", p_sent_to: "me@dev.lk", p_error: "DEV: sent to me@dev.lk instead of nimal@example.lk" });

    const off = setup([row()], { production: false, redirect: null });
    await deliverDue(off.ports, { now: () => NOW });
    expect(off.transport.sent).toEqual([]);
    expect(off.recorded[0]).toMatchObject({ p_outcome: "SKIPPED", p_error: expect.stringMatching(/^DEV_NO_REDIRECT/) });
  });

  it("production without a sending domain (EMAIL_FROM empty): skipped as NO_SENDER_DOMAIN, nothing sent, no PDF wait (decision 96)", async () => {
    const pending = row({ attachment: { kind: "INVOICE", number: "INV-000123", status: "PENDING", path: null } });
    const off = setup([row(), pending, row({ recipient: null })], { production: true, fromConfigured: false });
    const summary = await deliverDue(off.ports, { now: () => NOW });
    expect(off.transport.sent).toEqual([]);
    expect(summary).toMatchObject({ claimed: 3, skipped: 3, sent: 0, postponed: 0 });
    for (const r of off.recorded) expect(r).toMatchObject({ p_outcome: "SKIPPED", p_error: expect.stringMatching(/^NO_SENDER_DOMAIN: /) });

    // The direct login-details email takes the same path.
    const direct = await sendEmail(off.ports, {
      event: "account.credentials",
      category: "ESSENTIAL",
      role: "OWNER",
      to: "owner@example.lk",
      recipientName: "Owner",
      title: "Your RentDesk login details",
      message: "m",
      link: "/login",
      vars: {},
      company: null,
      template: null,
      attachments: [],
      idempotencyKey: "k",
      attempts: 0,
      at: NOW,
    });
    expect(direct).toEqual({ outcome: "SKIPPED", error: expect.stringMatching(/^NO_SENDER_DOMAIN/) });
    expect(off.transport.sent).toEqual([]);

    // Setting EMAIL_FROM turns it on with no code change.
    const on = setup([row()], { production: true, fromConfigured: true });
    await deliverDue(on.ports, { now: () => NOW });
    expect(on.transport.sent[0]).toMatchObject({ to: "nimal@example.lk" });

    // Outside production the redirect rules still apply, with or without EMAIL_FROM.
    const dev = setup([row()], { production: false, redirect: "me@dev.lk", fromConfigured: false });
    await deliverDue(dev.ports, { now: () => NOW });
    expect(dev.transport.sent[0]).toMatchObject({ to: "me@dev.lk" });
  });

  it("an owner's new URGENT request keeps URGENT first, even with the owner's own subject", async () => {
    const r = row({
      event: "service.raised",
      role: "OWNER",
      category: "UPDATE",
      attachment: null,
      data: { vars: { customer_name: "Perera", machine: "Canon", request: "Breakdown", priority: "URGENT: ", urgency: "Urgent" } },
      template: { subject: "Request from {customer_name}", body: "{message}", source: "OWNER" },
    });
    const { ports, transport } = setup([r]);
    await deliverDue(ports, { now: () => NOW });
    expect(transport.sent[0]).toMatchObject({ subject: "URGENT: Request from Perera", from: "RentDesk <notify@app.test>", replyTo: null });
    expect(transport.sent[0].text).toContain("You can turn off update emails in RentDesk");
  });

  it("SMS and WhatsApp have no provider yet: logged as skipped", async () => {
    const { ports, recorded } = setup([row({ channel: "SMS", recipient: "+94771234567", attachment: null })]);
    await deliverDue(ports, { now: () => NOW });
    expect(recorded[0]).toMatchObject({ p_outcome: "SKIPPED", p_error: expect.stringMatching(/^NO_PROVIDER/) });
  });

  it("a provider failure is retried with backoff; a bad address fails at once", async () => {
    const retry = setup([row({ attempts: 1 })]);
    retry.ports.email = fakeTransport({ fail: () => ({ ok: false, provider: "resend", status: 500, message: "boom" }) });
    await deliverDue(retry.ports, { now: () => NOW });
    expect(retry.recorded[0]).toMatchObject({ p_outcome: "RETRY", p_error: "500 boom", p_next_attempt_at: "2026-10-11T10:20:00.000Z" });

    const bad = setup([row()]);
    bad.ports.email = fakeTransport({ fail: () => ({ ok: false, provider: "resend", status: 422, message: "validation_error: invalid to" }) });
    await deliverDue(bad.ports, { now: () => NOW });
    expect(bad.recorded[0]).toMatchObject({ p_outcome: "FAILED" });
  });

  it("without an email setup, deliveries are skipped and logged", async () => {
    const { ports, recorded } = setup([row()]);
    ports.email = null;
    await deliverDue(ports, { now: () => NOW });
    expect(recorded[0]).toMatchObject({ p_outcome: "SKIPPED", p_error: expect.stringMatching(/^NOT_CONFIGURED/) });
  });
});
