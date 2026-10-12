import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildEmail, escapeHtml } from "./email-html";
import {
  absoluteLink,
  classifyStatus,
  destination,
  emailAllowance,
  footerNote,
  isProductionDeployment,
  nextUtcDay,
  type Quota,
  retryDelayMs,
  senderName,
  withPriority,
} from "./policy";
import { failureFromEvent, verifyWebhook } from "./webhook";

describe("non-production safety (decision 73)", () => {
  it("only the real deployment is production", () => {
    expect(isProductionDeployment({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ APP_ENV: "production" })).toBe(true);
    // next start for e2e, previews, dev: not production, even with NODE_ENV=production.
    expect(isProductionDeployment({ NODE_ENV: "production" })).toBe(false);
    expect(isProductionDeployment({ VERCEL_ENV: "preview" })).toBe(false);
    expect(isProductionDeployment({})).toBe(false);
  });

  it("production sends to the real address", () => {
    expect(destination({ to: "a@b.lk", subject: "Bill", production: true, redirect: "me@x.lk" })).toEqual({ kind: "send", to: "a@b.lk", subject: "Bill", devNote: null });
  });

  it("outside production everything goes to the redirect, marked [DEV], naming the real recipient", () => {
    expect(destination({ to: "a@b.lk", subject: "Bill", production: false, redirect: " me@x.lk " })).toEqual({
      kind: "send",
      to: "me@x.lk",
      subject: "[DEV] Bill",
      devNote: "Development copy. In production this email would go to a@b.lk.",
    });
  });

  it("outside production without a redirect nothing is sent", () => {
    for (const redirect of [undefined, null, "", "   "]) {
      expect(destination({ to: "a@b.lk", subject: "Bill", production: false, redirect })).toMatchObject({ kind: "skip", reason: expect.stringMatching(/^DEV_NO_REDIRECT/) });
    }
  });
});

describe("free-tier limits (decision 69)", () => {
  const q = (sent_today: number, sent_month = sent_today, over: Partial<Quota> = {}): Quota => ({
    sent_today,
    sent_month,
    daily_limit: 100,
    monthly_limit: 3000,
    reserve: 20,
    max_attempts: 5,
    ...over,
  });

  it("well below the limit: a full batch of any email", () => {
    expect(emailAllowance(q(10), 10)).toEqual({ limit: 10, essentialOnly: false });
  });

  it("inside the reserve: only essential emails", () => {
    expect(emailAllowance(q(80), 10)).toEqual({ limit: 10, essentialOnly: true });
    expect(emailAllowance(q(95), 10)).toEqual({ limit: 5, essentialOnly: true });
  });

  it("at the daily or the monthly limit: none", () => {
    expect(emailAllowance(q(100), 10)).toEqual({ limit: 0, essentialOnly: true });
    expect(emailAllowance(q(5, 3000), 10)).toEqual({ limit: 0, essentialOnly: true });
    expect(emailAllowance(q(5, 2985), 10)).toEqual({ limit: 10, essentialOnly: true });
  });

  it("deferred emails wait for the next UTC day (Resend's daily quota)", () => {
    // 00:30 Colombo is 19:00 UTC the day before.
    expect(nextUtcDay(new Date("2026-10-11T19:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(nextUtcDay(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("retries (decision 67)", () => {
  it("backs off 5 min, 20 min, 80 min, 5 h 20 min", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 20, 80, 320]);
  });

  it("retries network errors, 5xx and rate limits; gives up on 4xx; waits a day on the provider's quota", () => {
    expect(classifyStatus(null)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(429, "rate_limit_exceeded")).toBe("retry");
    expect(classifyStatus(429, "daily_quota_exceeded")).toBe("quota");
    expect(classifyStatus(422, "invalid email")).toBe("permanent");
    expect(classifyStatus(403, "domain not verified")).toBe("permanent");
  });
});

describe("sender and footer (decision 72)", () => {
  it("customers hear from their company via RentDesk; owners and admins from RentDesk", () => {
    expect(senderName("CUSTOMER", "Lanka Copiers")).toBe("Lanka Copiers via RentDesk");
    expect(senderName("CUSTOMER", 'Evil" <x@y>')).toBe("Evil x@y via RentDesk");
    expect(senderName("OWNER", "Lanka Copiers")).toBe("RentDesk");
    expect(senderName("CUSTOMER", null)).toBe("RentDesk");
  });

  it("only optional emails explain how to turn them off", () => {
    expect(footerNote("ESSENTIAL", "CUSTOMER", "https://app")).toBeNull();
    expect(footerNote("REMINDER", "CUSTOMER", "https://app")).toBe("You can turn off reminder emails in RentDesk: https://app/customer/help/notifications");
    expect(footerNote("UPDATE", "OWNER", "https://app")).toBe("You can turn off update emails in RentDesk: https://app/owner/settings/notifications");
  });

  it("links become absolute", () => {
    expect(absoluteLink("https://app/", "/customer/tickets/1")).toBe("https://app/customer/tickets/1");
    expect(absoluteLink("https://app", null)).toBeNull();
  });

  it("URGENT and HIGH lead the subject, once", () => {
    expect(withPriority("New service request: Perera", "URGENT: ")).toBe("URGENT: New service request: Perera");
    expect(withPriority("URGENT: New service request", "URGENT: ")).toBe("URGENT: New service request");
    expect(withPriority("New service request", "")).toBe("New service request");
  });
});

describe("email layout (BRD-02)", () => {
  it("escapes everything and keeps paragraphs", () => {
    const { html, text } = buildEmail({
      subject: "Bill <1>",
      body: "Hello <b>Nimal</b>,\n\nLine one\nline two",
      companyName: "A & B Copiers",
      logoCid: "company-logo",
      actionUrl: "https://app/x?a=1&b=2",
    });
    expect(html).toContain("Hello &lt;b&gt;Nimal&lt;/b&gt;,</p>");
    expect(html).toContain("Line one<br>line two");
    expect(html).toContain("A &amp; B Copiers");
    expect(html).toContain('src="cid:company-logo"');
    expect(html).toContain('href="https://app/x?a=1&amp;b=2"');
    expect(html).not.toContain("<b>");
    expect(text).toBe("Hello <b>Nimal</b>,\n\nLine one\nline two\n\nOpen in RentDesk: https://app/x?a=1&b=2\n\n--\n\nSent by A & B Copiers through RentDesk.");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("a development copy says who it was for, in both versions", () => {
    const { html, text } = buildEmail({ subject: "s", body: "b", companyName: "C", devNote: "Development copy. In production this email would go to a@b.lk." });
    expect(html).toContain("would go to a@b.lk");
    expect(text.startsWith("Development copy.")).toBe(true);
  });
});

describe("Resend webhook signature", () => {
  const secret = `whsec_${Buffer.from("test-secret-key").toString("base64")}`;
  const sign = (id: string, ts: string, body: string) =>
    `v1,${createHmac("sha256", Buffer.from("test-secret-key")).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const now = 1_760_000_000;

  it("accepts Resend's signature (any of several), refuses anything else", () => {
    const body = '{"type":"email.bounced"}';
    const ts = String(now);
    expect(verifyWebhook({ id: "msg_1", timestamp: ts, signature: `v1,old ${sign("msg_1", ts, body)}`, body }, secret, now)).toBe(true);
    expect(verifyWebhook({ id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, `${body} `), body }, secret, now)).toBe(false);
    expect(verifyWebhook({ id: "msg_2", timestamp: ts, signature: sign("msg_1", ts, body), body }, secret, now)).toBe(false);
    expect(verifyWebhook({ id: "msg_1", timestamp: ts, signature: null, body }, secret, now)).toBe(false);
    // Replays older than 5 minutes.
    const old = String(now - 301);
    expect(verifyWebhook({ id: "msg_1", timestamp: old, signature: sign("msg_1", old, body), body }, secret, now)).toBe(false);
  });

  it("bounces, complaints and failures mark the delivery failed; other events change nothing", () => {
    expect(failureFromEvent({ type: "email.bounced", data: { email_id: "re_1", bounce: { message: "No such user", type: "Permanent", subType: "General" } } })).toEqual({
      providerId: "re_1",
      reason: "Bounced (Permanent/General): No such user",
    });
    expect(failureFromEvent({ type: "email.complained", data: { email_id: "re_1" } })?.reason).toBe("Marked as spam by the recipient");
    expect(failureFromEvent({ type: "email.delivered", data: { email_id: "re_1" } })).toBeNull();
    expect(failureFromEvent({ type: "email.bounced", data: {} })).toBeNull();
  });
});
