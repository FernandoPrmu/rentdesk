import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend webhooks (decision 72): bounces and spam complaints mark the delivery
 * FAILED and alert the owner. Resend signs with Svix: HMAC-SHA256 over
 * "{svix-id}.{svix-timestamp}.{body}" with the base64 secret after "whsec_",
 * sent as "v1,{base64}" (several, space separated). Pure, so it is unit-tested.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhook(
  input: { id: string | null; timestamp: string | null; signature: string | null; body: string },
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface WebhookEvent {
  type: string;
  data?: { email_id?: string; bounce?: { message?: string; type?: string; subType?: string }; failed?: { reason?: string } };
}

/** What a Resend event means for the delivery, or null when nothing changes. */
export function failureFromEvent(event: WebhookEvent): { providerId: string; reason: string } | null {
  const id = event.data?.email_id;
  if (!id) return null;
  switch (event.type) {
    case "email.bounced": {
      const b = event.data?.bounce;
      const detail = [b?.type, b?.subType].filter(Boolean).join("/");
      return { providerId: id, reason: `Bounced${detail ? ` (${detail})` : ""}: ${b?.message ?? "the address does not accept email"}` };
    }
    case "email.complained":
      return { providerId: id, reason: "Marked as spam by the recipient" };
    case "email.failed":
      return { providerId: id, reason: `Failed: ${event.data?.failed?.reason ?? "rejected by the provider"}` };
    default:
      return null;
  }
}
