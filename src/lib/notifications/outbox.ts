import type { Rpc } from "../tickets/transitions.ts";
import { buildEmail } from "./email-html.ts";
import type { Audience, EmailCategory } from "./events.ts";
import {
  absoluteLink,
  classifyStatus,
  destination,
  emailAllowance,
  footerNote,
  nextUtcDay,
  NO_SENDER_DOMAIN,
  type Quota,
  retryDelayMs,
  senderDomainMissing,
  senderName,
  withPriority,
} from "./policy.ts";
import { type EmailTemplate, renderEmail } from "./template.ts";
import type { EmailAttachment, EmailTransport, TextTransport } from "./transport.ts";

/**
 * The outbox sender (NOT-02, decisions 65-69, 72-74). Deliveries are written by
 * the database in the same transaction as the business change; this claims the
 * due ones (lease + SKIP LOCKED), renders and sends them, and records each result.
 * Runs after a request (`after()`, see server.ts) and as the daily job's last step
 * (retries with backoff). Everything goes through ports so DB tests run it with
 * a fake transport. Relative imports only.
 */

export interface DeliveryRow {
  id: string;
  token: string;
  channel: "EMAIL" | "SMS" | "WHATSAPP";
  event: string;
  category: EmailCategory;
  attempts: number;
  created_at: string;
  recipient: string | null;
  user_id: string;
  owner_id: string | null;
  role: Audience;
  recipient_name: string | null;
  title: string;
  body: string;
  link: string | null;
  data: { vars?: Record<string, string> } & Record<string, unknown>;
  company: { name: string; email: string | null; logo_path: string | null } | null;
  template: (EmailTemplate & { source: "OWNER" | "GLOBAL" }) | null;
  attachment: { kind: "INVOICE" | "RECEIPT"; number: string | null; status: string; path: string | null } | null;
}

export type Bucket = "branding" | "invoices" | "receipts";

export interface OutboxConfig {
  appUrl: string;
  /** Sending address, e.g. notifications@mail.example.lk (EMAIL_FROM). */
  fromAddress: string;
  /** False when EMAIL_FROM is empty: in production email is then off (NO_SENDER_DOMAIN, decision 96). */
  fromConfigured?: boolean;
  production: boolean;
  /** EMAIL_DEV_REDIRECT (non-production). */
  devRedirect?: string | null;
  /** Reply-to for emails that are not from a company (EMAIL_REPLY_TO). */
  platformReplyTo?: string | null;
}

export interface OutboxPorts {
  rpc: Rpc;
  /** null: email is not configured, deliveries are skipped (and logged). */
  email: EmailTransport | null;
  text: TextTransport;
  readFile(bucket: Bucket, path: string): Promise<Uint8Array>;
  config: OutboxConfig;
  log?: (message: string) => void;
}

export interface OutboxOptions {
  now?: () => Date;
  /** Stop claiming new work after this long. */
  budgetMs?: number;
  batch?: number;
}

export interface OutboxSummary {
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  skipped: number;
  postponed: number;
  /** The daily or monthly limit stopped this run (decision 69). */
  limited: boolean;
  /** Nothing was due (one indexed read, no write), or another sender holds the lease. */
  idle?: boolean;
}

/** The sender lease outlives the time budget, so a live sender never loses it. */
const LEASE_SECONDS = 60;

/** How long an email waits for its PDF before going without it. */
export const PDF_WAIT_MS = 24 * 3600_000;
const PDF_POLL_MS = 10 * 60_000;

export type Outcome =
  | { outcome: "SENT"; provider: string; providerId: string; subject: string; sentTo: string; note: string | null }
  | { outcome: "RETRY"; error: string; next: Date }
  | { outcome: "FAILED"; error: string }
  | { outcome: "SKIPPED"; error: string }
  | { outcome: "POSTPONE"; error: string; next: Date };

export async function deliverDue(ports: OutboxPorts, options: OutboxOptions = {}): Promise<OutboxSummary> {
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? 10;
  const started = Date.now();
  const budget = options.budgetMs ?? 20_000;
  const summary: OutboxSummary = { claimed: 0, sent: 0, retry: 0, failed: 0, skipped: 0, postponed: 0, limited: false };
  const logos = new Map<string, Promise<Uint8Array | null>>();

  // One indexed check first: when nothing is due the sender stops here (no write).
  // Otherwise it takes the single sender lease: never two drains at once, anywhere.
  const token = (await ports.rpc("rpc_outbox_begin", { p_now: now().toISOString(), p_lease_seconds: LEASE_SECONDS })) as string | null;
  if (!token) return { ...summary, idle: true };
  try {
    await drainBatches();
  } finally {
    await ports.rpc("rpc_outbox_end", { p_token: token });
  }
  return summary;

  async function drainBatches() {
    while (Date.now() - started < budget) {
      const at = now();
      const quota = (await ports.rpc("rpc_email_quota", { p_now: at.toISOString() })) as Quota;
      const allowance = emailAllowance(quota, batch);
      if (allowance.limit === 0 || allowance.essentialOnly) summary.limited = true;
      const rows = ((await ports.rpc("rpc_claim_deliveries", {
        p_now: at.toISOString(),
        p_email_limit: allowance.limit,
        p_essential_only: allowance.essentialOnly,
        p_other_limit: batch,
      })) ?? []) as DeliveryRow[];
      if (rows.length === 0) break;
      summary.claimed += rows.length;

      for (const row of rows) {
        let result: Outcome;
        try {
          result = await deliverOne(ports, row, now(), logos);
        } catch (error) {
          result = { outcome: "RETRY", error: `Sender error: ${error instanceof Error ? error.message : String(error)}`, next: new Date(now().getTime() + retryDelayMs(row.attempts + 1)) };
        }
        await record(ports.rpc, row, result, now());
        if (result.outcome === "SENT") summary.sent += 1;
        else if (result.outcome === "RETRY") summary.retry += 1;
        else if (result.outcome === "FAILED") summary.failed += 1;
        else if (result.outcome === "SKIPPED") summary.skipped += 1;
        else summary.postponed += 1;
      }
    }
  }
}

async function record(rpc: Rpc, row: DeliveryRow, r: Outcome, at: Date) {
  await rpc("rpc_record_delivery_result", {
    p_id: row.id,
    p_token: row.token,
    p_outcome: r.outcome,
    p_now: at.toISOString(),
    p_error: r.outcome === "SENT" ? r.note : r.error,
    p_next_attempt_at: r.outcome === "RETRY" || r.outcome === "POSTPONE" ? r.next.toISOString() : null,
    p_provider: r.outcome === "SENT" ? r.provider : null,
    p_provider_id: r.outcome === "SENT" ? r.providerId : null,
    p_subject: r.outcome === "SENT" ? r.subject : null,
    p_sent_to: r.outcome === "SENT" ? r.sentTo : null,
  });
}

async function deliverOne(ports: OutboxPorts, row: DeliveryRow, at: Date, logos: Map<string, Promise<Uint8Array | null>>): Promise<Outcome> {
  if (row.channel !== "EMAIL") {
    const sent = await ports.text.send({ to: row.recipient ?? "", text: `${row.title}. ${row.body}`, channel: row.channel });
    if (sent.ok) return { outcome: "SENT", provider: sent.provider, providerId: sent.id, subject: row.title, sentTo: row.recipient ?? "", note: null };
    return { outcome: "SKIPPED", error: "NO_PROVIDER: SMS and WhatsApp need a paid provider (deferred)" };
  }
  // Production without a sending domain: skipped at once, never waiting for a PDF (decision 96).
  if (senderDomainMissing(ports.config)) return { outcome: "SKIPPED", error: NO_SENDER_DOMAIN };
  if (!row.recipient) return { outcome: "SKIPPED", error: "NO_EMAIL: no email address on the account" };

  // Attachment: the bill or receipt PDF (decision 72). Wait for it up to a day.
  const attachments: EmailAttachment[] = [];
  let note: string | null = null;
  if (row.attachment) {
    const a = row.attachment;
    if (a.status === "READY" && a.path) {
      try {
        const bytes = await ports.readFile(a.kind === "INVOICE" ? "invoices" : "receipts", a.path);
        attachments.push({ filename: `${a.kind === "INVOICE" ? "Bill" : "Receipt"}-${a.number ?? "document"}.pdf`, content: bytes, contentType: "application/pdf" });
      } catch (error) {
        return { outcome: "RETRY", error: `Could not read the PDF: ${error instanceof Error ? error.message : String(error)}`, next: new Date(at.getTime() + retryDelayMs(row.attempts + 1)) };
      }
    } else if (at.getTime() - new Date(row.created_at).getTime() < PDF_WAIT_MS) {
      return { outcome: "POSTPONE", error: "WAITING_FOR_PDF: the PDF is still being made", next: new Date(at.getTime() + PDF_POLL_MS) };
    } else {
      note = "The PDF is not attached; you can download it in RentDesk.";
    }
  }

  return sendEmail(ports, {
    event: row.event,
    category: row.category,
    role: row.role,
    to: row.recipient,
    recipientName: row.recipient_name,
    title: row.title,
    message: row.body,
    link: row.link,
    vars: row.data.vars ?? {},
    company: row.company,
    template: row.template,
    attachments,
    extraParagraph: note,
    idempotencyKey: `delivery-${row.id}`,
    attempts: row.attempts,
    at,
    logos,
  });
}

export interface ComposeInput {
  event: string;
  category: EmailCategory;
  role: Audience;
  to: string;
  recipientName: string | null;
  title: string;
  message: string;
  link: string | null;
  vars: Record<string, string>;
  company: DeliveryRow["company"];
  template: EmailTemplate | null;
  attachments: EmailAttachment[];
  extraParagraph?: string | null;
  idempotencyKey: string;
  attempts: number;
  at: Date;
  logos?: Map<string, Promise<Uint8Array | null>>;
}

/**
 * Renders (template → built-in → generic), applies the non-production redirect,
 * adds the logo and sends. Shared by the outbox and the direct login-details email.
 */
export async function sendEmail(ports: Pick<OutboxPorts, "email" | "readFile" | "config" | "log">, input: ComposeInput): Promise<Outcome> {
  if (senderDomainMissing(ports.config)) return { outcome: "SKIPPED", error: NO_SENDER_DOMAIN };
  if (!ports.email) return { outcome: "SKIPPED", error: "NOT_CONFIGURED: email is not set up (RESEND_API_KEY / EMAIL_FROM)" };
  const { config } = ports;
  const companyName = input.company?.name ?? "RentDesk";
  const link = absoluteLink(config.appUrl, input.link);
  const vars: Record<string, string> = {
    ...input.vars,
    recipient_name: input.recipientName || "there",
    company_name: companyName,
    title: input.title,
    message: input.message || input.title,
    ...(link ? { link } : {}),
  };
  const rendered = renderEmail(input.event, input.template, vars);
  if (rendered.source === "generic" && input.template) {
    ports.log?.(`[notifications] the ${input.event} template needs a variable this message lacks; the generic text was used`);
  }
  const subject = input.event === "service.raised" ? withPriority(rendered.subject, vars.priority) : rendered.subject;
  const body = input.extraParagraph ? [rendered.body, input.extraParagraph].join("\n\n") : rendered.body;

  const dest = destination({ to: input.to, subject, production: config.production, redirect: config.devRedirect });
  if (dest.kind === "skip") {
    ports.log?.(`[notifications] ${input.event} to ${input.to} not sent: ${dest.reason}`);
    return { outcome: "SKIPPED", error: dest.reason };
  }

  const attachments = [...input.attachments];
  if (input.company?.logo_path) {
    const path = input.company.logo_path;
    const logos = input.logos ?? new Map<string, Promise<Uint8Array | null>>();
    if (!logos.has(path)) logos.set(path, ports.readFile("branding", path).catch(() => null));
    const logo = await logos.get(path)!;
    if (logo) attachments.push({ filename: "logo.png", content: logo, contentType: "image/png", contentId: "company-logo" });
  }

  const email = buildEmail({
    subject: dest.subject,
    body,
    companyName,
    logoCid: attachments.some((a) => a.contentId) ? "company-logo" : null,
    actionUrl: link,
    footerNote: footerNote(input.category, input.role, config.appUrl),
    devNote: dest.devNote,
  });
  const replyTo = input.role === "CUSTOMER" ? (input.company?.email ?? null) : (config.platformReplyTo ?? null);
  const sent = await ports.email.send({
    from: `${senderName(input.role, input.company?.name ?? null)} <${config.fromAddress}>`,
    to: dest.to,
    replyTo,
    subject: dest.subject,
    html: email.html,
    text: email.text,
    attachments,
    idempotencyKey: input.idempotencyKey,
  });
  if (sent.ok) {
    return {
      outcome: "SENT",
      provider: sent.provider,
      providerId: sent.id,
      subject: dest.subject,
      sentTo: dest.to,
      note: dest.devNote ? `DEV: sent to ${dest.to} instead of ${input.to}` : null,
    };
  }
  const kind = classifyStatus(sent.status, sent.message);
  const error = `${sent.status ?? "network"} ${sent.message}`.trim();
  if (kind === "quota") return { outcome: "POSTPONE", error: `DEFERRED: provider limit reached (${error})`, next: nextUtcDay(input.at) };
  if (kind === "permanent") return { outcome: "FAILED", error };
  return { outcome: "RETRY", error, next: new Date(input.at.getTime() + retryDelayMs(input.attempts + 1)) };
}
