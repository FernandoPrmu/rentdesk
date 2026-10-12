/**
 * Delivery transports (NOT-02, NOT-03). Email goes through Resend's HTTP API;
 * tests and e2e use the fake (nothing leaves the machine). SMS and WhatsApp have
 * no paid provider yet: their stubs only log (deferred, decision 74).
 * Relative imports only (DB tests run the sender under Node).
 */

export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
  /** Inline image (referenced as cid:...). */
  contentId?: string;
}

export interface EmailMessage {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
  /** Same key = the provider sends once (Resend keeps it 24 h). */
  idempotencyKey: string;
}

export type SendResult = { ok: true; provider: string; id: string } | { ok: false; provider: string; status: number | null; message: string };

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}

export interface TextMessage {
  to: string;
  text: string;
  channel: "SMS" | "WHATSAPP";
}

export interface TextTransport {
  readonly name: string;
  send(message: TextMessage): Promise<SendResult>;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function resendTransport(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): EmailTransport {
  return {
    name: "resend",
    async send(m) {
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": m.idempotencyKey },
          body: JSON.stringify({
            from: m.from,
            to: [m.to],
            ...(m.replyTo ? { reply_to: m.replyTo } : {}),
            subject: m.subject,
            html: m.html,
            text: m.text,
            ...(m.attachments.length > 0
              ? {
                  attachments: m.attachments.map((a) => ({
                    filename: a.filename,
                    content: base64(a.content),
                    content_type: a.contentType,
                    ...(a.contentId ? { content_id: a.contentId } : {}),
                  })),
                }
              : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
        if (response.ok && body.id) return { ok: true, provider: "resend", id: body.id };
        return { ok: false, provider: "resend", status: response.status, message: `${body.name ?? "error"}: ${body.message ?? response.statusText}` };
      } catch (error) {
        return { ok: false, provider: "resend", status: null, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Records messages instead of sending them (unit, DB and e2e tests; EMAIL_TRANSPORT=fake). */
export function fakeTransport(options: { fail?: (m: EmailMessage) => SendResult | null } = {}): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  let n = 0;
  return {
    name: "fake",
    sent,
    async send(m) {
      const failure = options.fail?.(m);
      if (failure) return failure;
      sent.push(m);
      n += 1;
      return { ok: true, provider: "fake", id: `fake-${m.idempotencyKey}-${n}` };
    },
  };
}

/** SMS / WhatsApp until a paid provider is chosen: log only (NOT-03 deferred). */
export function stubTextTransport(log: (line: string) => void = console.info): TextTransport {
  return {
    name: "stub",
    async send(m) {
      log(`[notifications] ${m.channel} stub (no provider): to ${m.to.replace(/\d(?=\d{3})/g, "•")}: ${m.text.slice(0, 80)}`);
      return { ok: false, provider: "stub", status: 0, message: "NO_PROVIDER" };
    },
  };
}
