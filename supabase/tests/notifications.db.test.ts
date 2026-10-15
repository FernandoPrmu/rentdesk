import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deliveryCatalog } from "../../src/lib/notifications/events.ts";
import { deliverDue, type OutboxOptions, type OutboxPorts } from "../../src/lib/notifications/outbox.ts";
import { fakeTransport, type SendResult, stubTextTransport } from "../../src/lib/notifications/transport.ts";
import { APPLY_MIGRATIONS, asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { pgRpc } from "./rpc";

/**
 * Notifications (NOT-01..05, decisions 65-74): the email outbox written in the
 * business transaction, the sender with a fake transport (nothing leaves the test),
 * retries and backoff, the free-tier cap, preferences, templates, RLS.
 */
describe.skipIf(!DB_URL)("notifications (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  // The database clock minus this machine's: a row is due from the database's `now()`, and a
  // local clock a few seconds behind would find nothing due yet (measured once, in beforeAll).
  let skewMs = 0;
  const dbNow = () => Date.now() + skewMs;
  /** The sender on the database's clock. */
  const send = (p: OutboxPorts, options: OutboxOptions = {}) => deliverDue(p, { now: () => new Date(dbNow()), ...options });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
  const deliveries = (userId: string, event: string) =>
    db.query<{ id: string; status: string; recipient: string | null; last_error: string | null; attempts: number; next_attempt_at: Date; category: string; sent_to: string | null; subject: string | null }>(
      "select * from public.notification_deliveries where user_id = $1 and event = $2 order by created_at",
      [userId, event],
    ).then((r) => r.rows);

  /** The sender over this connection, with a fake transport; only the fixture's rows are due. */
  function ports(transport = fakeTransport(), files: Record<string, Uint8Array> = {}): OutboxPorts & { transport: ReturnType<typeof fakeTransport> } {
    return {
      rpc: pgRpc(db),
      email: transport,
      transport,
      text: stubTextTransport(() => {}),
      readFile: async (bucket, path) => {
        const bytes = files[`${bucket}/${path}`];
        if (!bytes) throw new Error(`missing ${bucket}/${path}`);
        return bytes;
      },
      config: { appUrl: "https://rentdesk.test", fromAddress: "notify@rentdesk.test", production: true },
    };
  }

  beforeAll(async () => {
    db = await connect();
    const before = Date.now();
    const { rows } = await db.query<{ t: Date }>("select clock_timestamp() as t");
    skewMs = rows[0].t.getTime() - (before + Date.now()) / 2;
    await begin(db);
    f = await createFixture(db);
    // Only this test's deliveries are due, and the dev database's real sends never count.
    await db.query(
      "update public.notification_deliveries set next_attempt_at = 'infinity' where status = 'PENDING' and (owner_id is null or owner_id <> all($1::uuid[]))",
      [[f.ownerA, f.ownerB]],
    );
    await db.query("update public.platform_settings set email_daily_limit = 100000, email_monthly_limit = 1000000, email_essential_reserve = 20 where id");
    // A real sender of the dev app may hold the lease right now: free it inside this transaction.
    await db.query("update public.outbox_lease set holder = null, locked_until = '-infinity' where id");
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  it("the catalogue in SQL equals the TypeScript one", async () => {
    const { rows } = await db.query<{ event: string; category: string; email: boolean; sms: boolean }>(
      "select event, category, email, sms from public.notification_events order by event collate \"C\"",
    );
    expect(rows).toEqual(deliveryCatalog().sort((a, b) => (a.event < b.event ? -1 : 1)));
  });

  it("an email row is written with the in-app row, in the same transaction; a rollback leaves nothing to send", async () => {
    await isolated(db, async () => {
      // Changing the email queues the test message (spec 11.8) in the same statement's transaction.
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      const [d] = await deliveries(f.custA1, "account.contact_changed");
      expect(d).toMatchObject({ status: "PENDING", recipient: "a1@example.lk", category: "ESSENTIAL" });
      expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'account.contact_changed'", [f.custA1])).toBe(1);

      // A change that rolls back: no notification, no delivery, nothing for the sender.
      await db.query("savepoint change");
      await db.query("update public.customers set email = 'other@example.lk' where id = $1", [f.custA2]);
      expect(await deliveries(f.custA2, "account.contact_changed")).toHaveLength(1);
      await db.query("rollback to savepoint change");
      expect(await deliveries(f.custA2, "account.contact_changed")).toHaveLength(0);

      const p = ports();
      const s = await send(p);
      expect(s.sent).toBe(1);
      expect(p.transport.sent.map((m) => m.to)).toEqual(["a1@example.lk"]);
      expect(p.transport.sent[0]).toMatchObject({ from: "Owner A Copiers via RentDesk <notify@rentdesk.test>", subject: "Your email address for Owner A Copiers" });
      expect(p.transport.sent[0].text).toMatch(/will be sent to a1@example\.lk/);
      expect((await deliveries(f.custA1, "account.contact_changed"))[0]).toMatchObject({ status: "SENT", sent_to: "a1@example.lk", attempts: 1 });

      // Sending again finds nothing (no double send).
      expect((await send(p)).claimed).toBe(0);
    });
  });

  // Needs the table on the other connection too: skipped while testing unpushed migrations.
  it.skipIf(APPLY_MIGRATIONS)("another connection (the sender) never sees the outbox row of an open transaction", async () => {
    const other = await connect();
    await db.query("savepoint open_change");
    try {
      await other.query("begin");
      await db.query("update public.customers set email = 'invisible@example.lk' where id = $1", [f.custA2]);
      const [d] = await deliveries(f.custA2, "account.contact_changed");
      const { rows } = await other.query("select 1 from public.notification_deliveries where id = $1", [d.id]);
      expect(rows).toHaveLength(0);
    } finally {
      await db.query("rollback to savepoint open_change");
      await other.query("rollback");
      await other.end();
    }
  });

  it("no address and turned-off categories are logged as SKIPPED; essential ones always go", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      // custA2 has no email: in-app only, logged.
      await rpc("rpc_notify_once", {
        p_owner_id: f.ownerA,
        p_dedupe_key: "t-due-a2",
        p_notifications: [{ user_id: f.custA2, event: "payment.due_soon", title: "Bill due", body: "Pay soon" }],
      });
      expect((await deliveries(f.custA2, "payment.due_soon"))[0]).toMatchObject({ status: "SKIPPED", recipient: null, last_error: expect.stringMatching(/^NO_EMAIL/) });

      // custA1 turns reminders off: reminders skipped, essential still pending.
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      await rpc("rpc_save_notification_preferences", { p_user_id: f.custA1, p_reminders: false, p_updates: true });
      await rpc("rpc_notify_once", {
        p_owner_id: f.ownerA,
        p_dedupe_key: "t-due-a1",
        p_notifications: [
          { user_id: f.custA1, event: "payment.due_soon", title: "Bill due", body: "Pay soon" },
          { user_id: f.custA1, event: "invoice.late_fee", title: "Late fee", body: "Added" },
          { user_id: f.custA1, event: "comment.added", title: "Message", body: "Hi" },
        ],
      });
      expect((await deliveries(f.custA1, "payment.due_soon"))[0]).toMatchObject({ status: "SKIPPED", last_error: expect.stringMatching(/^OPTED_OUT/) });
      expect((await deliveries(f.custA1, "invoice.late_fee"))[0]).toMatchObject({ status: "PENDING", category: "ESSENTIAL" });
      // In-app only events get no delivery at all.
      expect(await deliveries(f.custA1, "comment.added")).toHaveLength(0);
      expect(await one("select email_reminders, email_updates, owner_id from public.notification_preferences where user_id = $1", [f.custA1])).toEqual({
        email_reminders: false,
        email_updates: true,
        owner_id: f.ownerA,
      });
    });
  });

  it("retries with backoff, fails after the last attempt and alerts the owner; a permanent error fails at once", async () => {
    await isolated(db, async () => {
      await db.query("update public.platform_settings set email_max_attempts = 3 where id");
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      const failing = fakeTransport({ fail: (): SendResult => ({ ok: false, provider: "resend", status: 503, message: "unavailable" }) });
      let clock = dbNow();
      const p = ports(failing);
      const run = () => send(p, { now: () => new Date(clock) });

      await run();
      let [d] = await deliveries(f.custA1, "account.contact_changed");
      expect(d).toMatchObject({ status: "PENDING", attempts: 1, last_error: "503 unavailable" });
      expect(d.next_attempt_at.getTime() - clock).toBe(5 * 60_000);

      // Not due yet: nothing happens.
      clock += 60_000;
      expect((await run()).claimed).toBe(0);

      clock += 5 * 60_000;
      await run();
      [d] = await deliveries(f.custA1, "account.contact_changed");
      expect(d).toMatchObject({ status: "PENDING", attempts: 2 });
      expect(d.next_attempt_at.getTime() - clock).toBe(20 * 60_000);

      clock += 21 * 60_000;
      await run();
      [d] = await deliveries(f.custA1, "account.contact_changed");
      expect(d).toMatchObject({ status: "FAILED", attempts: 3 });
      // Spec 11.2: the owner hears that the customer was not reached (in-app).
      const alert = await one<{ title: string; link: string }>("select title, link from public.notifications where user_id = $1 and event = 'email.failed'", [f.ownerA]);
      expect(alert).toEqual({ title: "Email to Customer A1 could not be delivered", link: `/owner/customers/${f.custA1}` });

      // A 4xx (bad address) is not retried.
      await db.query("update public.customers set email = 'bad@example.lk' where id = $1", [f.custA2]);
      await send(ports(fakeTransport({ fail: () => ({ ok: false, provider: "resend", status: 422, message: "invalid_to" }) })));
      expect((await deliveries(f.custA2, "account.contact_changed"))[0]).toMatchObject({ status: "FAILED", attempts: 1 });
    });
  });

  it("a claim is leased: a second sender does not take the same rows; a stale result changes nothing", async () => {
    await isolated(db, async () => {
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      const rpc = pgRpc(db);
      const now = new Date().toISOString();
      const first = (await rpc("rpc_claim_deliveries", { p_now: now, p_email_limit: 10, p_essential_only: false })) as { id: string; token: string }[];
      expect(first).toHaveLength(1);
      expect(await rpc("rpc_claim_deliveries", { p_now: now, p_email_limit: 10, p_essential_only: false })).toEqual([]);
      // Wrong token (a sender whose lease ran out): ignored.
      expect(await rpc("rpc_record_delivery_result", { p_id: first[0].id, p_token: crypto.randomUUID(), p_outcome: "SENT", p_now: now })).toEqual({ skipped: true });
      // After the lease, another sender may take it.
      const later = new Date(Date.now() + 3 * 60_000).toISOString();
      const again = (await rpc("rpc_claim_deliveries", { p_now: later, p_email_limit: 10, p_essential_only: false })) as { id: string }[];
      expect(again.map((r) => r.id)).toEqual([first[0].id]);
    });
  });

  it("the sender checks cheaply first and holds one lease: nothing due = no write; never two senders at once", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      const now = new Date().toISOString();
      // Nothing due (only this test's rows count, and there are none yet).
      expect(await rpc("rpc_outbox_begin", { p_now: now })).toBeNull();
      expect((await one<{ holder: string | null }>("select holder from public.outbox_lease")).holder).toBeNull();

      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      const first = (await rpc("rpc_outbox_begin", { p_now: now })) as string;
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      // A second sender (another server instance) gets nothing while the lease is held.
      expect(await rpc("rpc_outbox_begin", { p_now: now })).toBeNull();
      expect((await send(ports())).idle).toBe(true);
      // Only the holder can give it back; then the next sender may take it.
      await rpc("rpc_outbox_end", { p_token: crypto.randomUUID() });
      expect(await rpc("rpc_outbox_begin", { p_now: now })).toBeNull();
      await rpc("rpc_outbox_end", { p_token: first });
      expect(await rpc("rpc_outbox_begin", { p_now: now })).not.toBeNull();
      // A lease that was never given back (a crashed sender) runs out.
      await db.query("update public.outbox_lease set locked_until = clock_timestamp() - interval '1 second' where id");
      expect(await rpc("rpc_outbox_begin", { p_now: now })).not.toBeNull();
    });
  });

  it("the bell gets one private Broadcast signal per user and statement (no notification content)", async () => {
    await isolated(db, async () => {
      const signals = () => count(db, "select 1 from realtime.messages where topic = $1", [`notifications:${f.custA1}`]);
      const before = await signals();
      const rpc = pgRpc(db);
      await rpc("rpc_notify_once", {
        p_owner_id: f.ownerA,
        p_dedupe_key: "t-bell",
        p_notifications: [
          { user_id: f.custA1, event: "comment.added", title: "One", body: "x" },
          { user_id: f.custA1, event: "comment.added", title: "Two", body: "x" },
        ],
      });
      const afterInsert = await signals();
      expect(afterInsert - before).toBeGreaterThanOrEqual(1);
      const { rows } = await db.query("select event, private, payload from realtime.messages where topic = $1 order by inserted_at desc limit 1", [`notifications:${f.custA1}`]);
      expect(rows[0]).toMatchObject({ event: "changed", private: true });
      expect(JSON.stringify(rows[0].payload)).not.toContain("One");

      // Marking all read in one statement: one signal; nothing changed: none.
      await db.query("update public.notifications set read_at = now() where user_id = $1 and read_at is null", [f.custA1]);
      expect((await signals()) - afterInsert).toBe(1);
      await db.query("update public.notifications set title = title where user_id = $1", [f.custA1]);
      expect((await signals()) - afterInsert).toBe(1);
      // Only the user may receive their topic (policy on realtime.messages).
      expect(await count(db, "select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'rentdesk: own bell signals'")).toBe(1);
    });
  });

  it("near the daily limit only essential emails go; the rest wait for the next UTC day; old reminders expire", async () => {
    await isolated(db, async () => {
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      const rpc = pgRpc(db);
      await rpc("rpc_notify_once", {
        p_owner_id: f.ownerA,
        p_dedupe_key: "t-cap",
        p_notifications: [
          { user_id: f.custA1, event: "payment.due_today", title: "Due today", body: "Pay" },
          { user_id: f.custA1, event: "meter.rejected", title: "Send again", body: "Dark" },
        ],
      });
      // 8 sent today through Resend; limit 10, reserve 5: inside the reserve.
      await db.query("update public.platform_settings set email_daily_limit = 10, email_essential_reserve = 5 where id");
      await db.query(
        `insert into public.notification_deliveries (owner_id, user_id, event, channel, category, status, provider, provider_id, sent_at)
         select $1, $2, 'test.sent', 'EMAIL', 'UPDATE', 'SENT', 'resend', gen_random_uuid()::text, now() - interval '1 minute' from generate_series(1, 8)`,
        [f.ownerA, f.custA1],
      );
      const p = ports();
      const s = await send(p);
      expect(s.limited).toBe(true);
      expect(p.transport.sent.map((m) => m.subject)).toEqual(["Your email address for Owner A Copiers"]); // the essential one
      for (const event of ["payment.due_today", "meter.rejected"]) {
        const [d] = await deliveries(f.custA1, event);
        expect(d.status, event).toBe("PENDING");
        expect(d.last_error, event).toMatch(/^DEFERRED/);
        const nextDay = new Date();
        nextDay.setUTCHours(24, 0, 0, 0);
        expect(d.next_attempt_at.toISOString(), event).toBe(nextDay.toISOString());
      }

      // At the limit, nothing goes, not even essential ones.
      await db.query("update public.platform_settings set email_daily_limit = 8 where id");
      await db.query("update public.customers set email = 'a1-new@example.lk' where id = $1", [f.custA1]);
      expect((await send(p)).sent).toBe(0);
      expect((await deliveries(f.custA1, "account.contact_changed")).map((d) => d.status)).toEqual(["SENT", "PENDING"]);

      // A reminder still waiting after the expiry is skipped, never sent late.
      const fourDays = new Date(Date.now() + 4 * 86_400_000).toISOString();
      await rpc("rpc_claim_deliveries", { p_now: fourDays, p_email_limit: 0, p_essential_only: true });
      expect((await deliveries(f.custA1, "payment.due_today"))[0]).toMatchObject({ status: "SKIPPED", last_error: expect.stringMatching(/^EXPIRED/) });
      expect((await deliveries(f.custA1, "meter.rejected"))[0].status).toBe("PENDING"); // updates do not expire
    });
  });

  it("templates: owner override, then the admin's global text, then the built-in one; who may change which", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      await db.query("update public.customers set email = 'b1@example.lk' where id = $1", [f.custB1]);
      await rpc("rpc_save_notification_template", { p_actor_id: f.admin, p_owner_id: null, p_event: "account.contact_changed", p_subject: "Global: {email}", p_body: "Global {recipient_name}" });
      await rpc("rpc_save_notification_template", { p_actor_id: f.ownerA, p_owner_id: f.ownerA, p_event: "account.contact_changed", p_subject: "Owner A: {email}", p_body: "From A to {recipient_name}" });
      const p = ports();
      await send(p);
      const byTo = Object.fromEntries(p.transport.sent.map((m) => [m.to, m.subject]));
      expect(byTo).toEqual({ "a1@example.lk": "Owner A: a1@example.lk", "b1@example.lk": "Global: b1@example.lk" });

      // Owners change only their own; admins only the global one; unknown events are refused.
      for (const [actor, owner] of [[f.ownerA, f.ownerB], [f.ownerA, null], [f.admin, f.ownerA], [f.custA1, f.ownerA]] as const) {
        await expect(rpc("rpc_save_notification_template", { p_actor_id: actor, p_owner_id: owner, p_event: "invoice.issued", p_subject: "x", p_body: "y" })).rejects.toThrow(/Not allowed/);
      }
      await expect(rpc("rpc_save_notification_template", { p_actor_id: f.ownerA, p_owner_id: f.ownerA, p_event: "comment.added", p_subject: "x", p_body: "y" })).rejects.toThrow(/Unknown email event/);

      // Reset to default removes the override; the audit log keeps the change.
      expect(await rpc("rpc_reset_notification_template", { p_actor_id: f.ownerA, p_owner_id: f.ownerA, p_event: "account.contact_changed" })).toEqual({ deleted: 1 });
      expect(await count(db, "select 1 from public.audit_logs where entity = 'notification_templates' and owner_id = $1", [f.ownerA])).toBeGreaterThanOrEqual(2);

      // Clients cannot write templates directly any more (the server checks the variables first).
      await asUser(db, f.ownerA);
      expect((await sqlError(db, "update public.notification_templates set body = 'x' where owner_id = $1", [f.ownerA]))?.code).toBe("42501");
      await asPostgres(db);
    });
  });

  it("the bill's PDF is attached; the email waits while the PDF is being made", async () => {
    await isolated(db, async () => {
      await db.query("update public.customers set email = 'a2@example.lk' where id = $1", [f.custA2]);
      await db.query("update public.notification_deliveries set next_attempt_at = 'infinity' where user_id = $1", [f.custA2]); // the test message
      const n = await one<{ id: string }>("select id from public.notifications where user_id = $1 and event = 'invoice.issued'", [f.custA2]);
      const { id } = await one<{ id: string }>(
        "insert into public.notification_deliveries (notification_id, owner_id, user_id, event, channel, category, priority, recipient) values ($1, $2, $3, 'invoice.issued', 'EMAIL', 'ESSENTIAL', 0, 'a2@example.lk') returning id",
        [n.id, f.ownerA, f.custA2],
      );
      const delivery = () => one<{ status: string; attempts: number; last_error: string | null }>("select status, attempts, last_error from public.notification_deliveries where id = $1", [id]);
      await db.query("update public.invoices set pdf_status = 'PENDING', pdf_path = null where id = $1", [f.invoices.a2Mono]);
      const p = ports(fakeTransport(), { [`invoices/${f.ownerA}/${f.invoices.a2Mono}/v1.pdf`]: new Uint8Array([37, 80, 68, 70]) });
      expect(await send(p)).toMatchObject({ postponed: 1, sent: 0 });
      expect(await delivery()).toMatchObject({ status: "PENDING", attempts: 0, last_error: expect.stringMatching(/^WAITING_FOR_PDF/) });

      await db.query("update public.invoices set pdf_status = 'READY', pdf_path = $2 where id = $1", [f.invoices.a2Mono, `${f.ownerA}/${f.invoices.a2Mono}/v1.pdf`]);
      await db.query("update public.notification_deliveries set next_attempt_at = now() where id = $1", [id]);
      expect((await send(p)).sent).toBe(1);
      expect((await delivery()).status).toBe("SENT");
      const invoiceNo = (await one<{ invoice_no: string }>("select invoice_no from public.invoices where id = $1", [f.invoices.a2Mono])).invoice_no;
      expect(p.transport.sent[0].attachments.map((a) => a.filename)).toEqual([`Bill-${invoiceNo}.pdf`]);
    });
  });

  it("suspending an owner tells their active customers; reactivating tells them again", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      await rpc("rpc_set_account_status", { p_actor_id: f.admin, p_target_id: f.ownerA, p_status: "SUSPENDED", p_reason: "Unpaid plan" });
      const titles = await db.query<{ user_id: string; title: string }>(
        "select user_id, title from public.notifications where event = 'account.owner_suspended' order by user_id",
      );
      expect(titles.rows.map((r) => r.user_id).sort()).toEqual([f.custA1, f.custA2].sort());
      expect(titles.rows[0].title).toBe("Owner A Copiers is on hold in RentDesk");
      expect((await deliveries(f.custA1, "account.owner_suspended"))[0]).toMatchObject({ status: "PENDING", recipient: "a1@example.lk" });
      expect((await deliveries(f.custA2, "account.owner_suspended"))[0]).toMatchObject({ status: "SKIPPED" });
      // Customer B1 (another owner) hears nothing.
      expect(await count(db, "select 1 from public.notifications where user_id = $1 and event like 'account.owner_%'", [f.custB1])).toBe(0);

      await rpc("rpc_set_account_status", { p_actor_id: f.admin, p_target_id: f.ownerA, p_status: "ACTIVE", p_reason: "Paid" });
      expect(await deliveries(f.custA1, "account.owner_active")).toHaveLength(1);
    });
  });

  it("a bounce reported by Resend fails the delivery and alerts the owner once; direct sends are logged without the password", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      await send(ports(fakeTransport({ fail: () => null })));
      const [d] = await deliveries(f.custA1, "account.contact_changed");
      await db.query("update public.notification_deliveries set provider = 'resend', provider_id = 're_123' where id = $1", [d.id]);
      expect(await rpc("rpc_mark_delivery_bounced", { p_provider_id: "re_123", p_reason: "Bounced: mailbox does not exist" })).toMatchObject({ found: true });
      expect(await rpc("rpc_mark_delivery_bounced", { p_provider_id: "re_123", p_reason: "again" })).toMatchObject({ skipped: true });
      expect((await deliveries(f.custA1, "account.contact_changed"))[0]).toMatchObject({ status: "FAILED", last_error: "Bounced: mailbox does not exist" });
      expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'email.failed'", [f.ownerA])).toBe(1);

      const id = await rpc("rpc_log_direct_delivery", {
        p_owner_id: f.ownerA, p_user_id: f.custA2, p_event: "account.credentials", p_subject: "Your RentDesk login for Owner A Copiers",
        p_recipient: "a2@example.lk", p_status: "SENT", p_error: null, p_provider: "fake", p_provider_id: "fake-1", p_sent_to: "a2@example.lk", p_now: new Date().toISOString(),
      });
      expect(await one("select status, notification_id, category, attempts from public.notification_deliveries where id = $1", [id])).toEqual({ status: "SENT", notification_id: null, category: "ESSENTIAL", attempts: 1 });
      // Another tenant's user cannot be logged under this owner.
      await expect(rpc("rpc_log_direct_delivery", {
        p_owner_id: f.ownerA, p_user_id: f.custB1, p_event: "account.credentials", p_subject: "x", p_recipient: null, p_status: "SKIPPED",
        p_error: null, p_provider: null, p_provider_id: null, p_sent_to: null, p_now: new Date().toISOString(),
      })).rejects.toThrow(/outside this tenant/);
    });
  });

  it("RLS: the delivery log is the admin's (all) and the owner's (own tenant); customers see none; preferences are private", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      await db.query("update public.customers set email = 'a1@example.lk' where id = $1", [f.custA1]);
      await db.query("update public.customers set email = 'b1@example.lk' where id = $1", [f.custB1]);
      await rpc("rpc_save_notification_preferences", { p_user_id: f.custA1, p_reminders: false, p_updates: false });
      await rpc("rpc_save_notification_preferences", { p_user_id: f.custB1, p_reminders: true, p_updates: false });

      await asUser(db, f.ownerA);
      expect(await count(db, "select 1 from public.notification_deliveries where owner_id = $1", [f.ownerA])).toBeGreaterThan(0);
      expect(await count(db, "select 1 from public.notification_deliveries where owner_id is distinct from $1", [f.ownerA])).toBe(0);
      expect(await count(db, "select 1 from public.notification_log where owner_id is distinct from $1", [f.ownerA])).toBe(0);
      expect(await count(db, "select 1 from public.notification_log where user_id = $1 and channel = 'EMAIL'", [f.custA1])).toBeGreaterThan(0);
      expect(await count(db, "select 1 from public.notification_preferences")).toBe(0);
      expect((await sqlError(db, "insert into public.notification_deliveries (user_id, event, channel, category) values ($1, 'x', 'EMAIL', 'UPDATE')", [f.ownerA]))?.code).toBe("42501");

      await asPostgres(db);
      await asUser(db, f.custA1);
      expect(await count(db, "select 1 from public.notification_deliveries")).toBe(0);
      expect(await count(db, "select 1 from public.notification_log where channel <> 'IN_APP'")).toBe(0);
      expect(await count(db, "select 1 from public.notification_log where user_id <> $1", [f.custA1])).toBe(0);
      expect(await count(db, "select 1 from public.notification_preferences")).toBe(1);
      // Own in-app rows can be marked read (Realtime + centre); nothing else changes.
      expect((await db.query("update public.notifications set read_at = now() where user_id = $1 and read_at is null", [f.custA1])).rowCount).toBeGreaterThan(0);
      expect((await sqlError(db, "update public.notifications set title = 'x' where user_id = $1", [f.custA1]))?.code).toBe("42501");

      await asPostgres(db);
      await asUser(db, f.admin);
      expect(await count(db, "select 1 from public.notification_deliveries where owner_id = any($1::uuid[])", [[f.ownerA, f.ownerB]])).toBeGreaterThan(1);
      await asPostgres(db);

      await asService(db);
      expect(await count(db, "select 1 from public.notification_deliveries where owner_id = $1", [f.ownerB])).toBeGreaterThan(0);
      await asPostgres(db);
    });
  });
});
