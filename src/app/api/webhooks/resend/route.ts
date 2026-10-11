import { failureFromEvent, verifyWebhook, type WebhookEvent } from "@/lib/notifications/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resend webhook (decision 72): a bounced, failed or complained email marks its
 * delivery FAILED and tells the owner (or the admins). Off until
 * RESEND_WEBHOOK_SECRET is set; every request must carry Resend's (Svix) signature.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return new Response(null, { status: 404 });

  const body = await request.text();
  const valid = verifyWebhook(
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      body,
    },
    secret,
  );
  if (!valid) return Response.json({ error: "Invalid signature" }, { status: 401 });

  let event: WebhookEvent;
  try {
    event = JSON.parse(body) as WebhookEvent;
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const failure = failureFromEvent(event);
  if (!failure) return Response.json({ ok: true, ignored: event.type });

  const { data, error } = await createAdminClient().rpc("rpc_mark_delivery_bounced", { p_provider_id: failure.providerId, p_reason: failure.reason });
  if (error) {
    console.error("[notifications] webhook:", error.message);
    // Resend retries on a 5xx.
    return Response.json({ error: "Not recorded" }, { status: 500 });
  }
  return Response.json({ ok: true, result: data });
}
