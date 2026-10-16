import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { emailAllowance, type Quota } from "./policy";
import { sendEmail } from "./outbox";
import { outboxPorts } from "./server";

/**
 * Login details by email (ADM-03, CUS-02; decision 70). The temporary password is
 * never stored, not even in the outbox, so this email is sent directly inside the
 * request that made the password, and only the result (no password) is logged in
 * the delivery log. It is not retried: a new reset sends a new password. The
 * one-time dialog still shows the details either way.
 */

export type LoginEmailResult = { status: "SENT"; to: string } | { status: "FAILED" | "SKIPPED"; to: string | null; message: string };

export async function emailLoginDetails(input: {
  userId: string;
  role: "OWNER" | "CUSTOMER";
  /** The tenant: the customer's owner, or the owner itself. */
  ownerId: string;
  email: string | null | undefined;
  name: string;
  username: string;
  temporaryPassword: string;
  reset: boolean;
}): Promise<LoginEmailResult> {
  const to = input.email?.trim() || null;
  if (!to) return { status: "SKIPPED", to: null, message: "No email address on the account." };

  const admin = createAdminClient();
  const ports = outboxPorts(admin);
  const now = new Date();
  const title = input.reset ? "Your new temporary password" : "Your RentDesk login details";
  const log = async (status: "SENT" | "FAILED" | "SKIPPED", error: string | null, extra: { provider?: string; providerId?: string; subject?: string; sentTo?: string } = {}) => {
    const { error: logError } = await admin.rpc("rpc_log_direct_delivery", {
      p_owner_id: input.ownerId,
      p_user_id: input.userId,
      p_event: "account.credentials",
      p_subject: extra.subject ?? title,
      p_recipient: to,
      p_status: status,
      p_error: error as string,
      p_provider: (extra.provider ?? null) as string,
      p_provider_id: (extra.providerId ?? null) as string,
      p_sent_to: (extra.sentTo ?? null) as string,
      p_now: now.toISOString(),
    });
    if (logError) console.error("[notifications] login details log:", logError.message);
  };

  const { data: quota, error: quotaError } = await admin.rpc("rpc_email_quota", { p_now: now.toISOString() });
  if (quotaError) {
    console.error("[notifications] quota:", quotaError.message);
    return { status: "FAILED", to, message: "The email could not be sent. Please give the details yourself." };
  }
  if (emailAllowance(quota as unknown as Quota, 1).limit === 0) {
    await log("SKIPPED", "DEFERRED: daily email limit reached");
    return { status: "SKIPPED", to, message: "Today's email limit is reached. Please give the details yourself." };
  }

  // Customers see their rental company's name and logo; owners hear from RentDesk.
  let company: { name: string; email: string | null; logo_path: string | null } | null = null;
  if (input.role === "CUSTOMER") {
    const { data } = await admin
      .from("owners")
      .select("business_name, email, owner_company_profiles(company_name, email, logo_path)")
      .eq("id", input.ownerId)
      .maybeSingle();
    if (data) {
      const cp = Array.isArray(data.owner_company_profiles) ? data.owner_company_profiles[0] : data.owner_company_profiles;
      company = { name: cp?.company_name ?? data.business_name, email: cp?.email || data.email || null, logo_path: cp?.logo_path ?? null };
    }
  }
  const { data: templates } = await admin
    .from("notification_templates")
    .select("owner_id, subject, body")
    .eq("event", "account.credentials")
    .eq("channel", "EMAIL")
    .eq("locale", "en")
    .or(input.role === "CUSTOMER" ? `owner_id.eq.${input.ownerId},owner_id.is.null` : "owner_id.is.null");
  const template = (templates ?? []).sort((a, b) => (a.owner_id ? 0 : 1) - (b.owner_id ? 0 : 1))[0] ?? null;

  const result = await sendEmail(ports, {
    event: "account.credentials",
    category: "ESSENTIAL",
    role: input.role,
    to,
    recipientName: input.name,
    title,
    message: `Your username is ${input.username}. Use the temporary password you were given to sign in, then choose your own.`,
    link: "/login",
    vars: { username: input.username, temporary_password: input.temporaryPassword, login_url: `${ports.config.appUrl}/login` },
    company,
    template: template ? { subject: template.subject, body: template.body } : null,
    attachments: [],
    idempotencyKey: `credentials-${input.userId}-${now.getTime()}`,
    attempts: 0,
    at: now,
  });

  if (result.outcome === "SENT") {
    await log("SENT", result.note, { provider: result.provider, providerId: result.providerId, subject: result.subject, sentTo: result.sentTo });
    return { status: "SENT", to };
  }
  const message = result.outcome === "SKIPPED" ? result.error : result.error;
  await log(result.outcome === "SKIPPED" ? "SKIPPED" : "FAILED", message);
  return {
    status: result.outcome === "SKIPPED" ? "SKIPPED" : "FAILED",
    to,
    message:
      result.outcome === "SKIPPED" && message.startsWith("NO_SENDER_DOMAIN")
        ? "Not sent: email is not set up yet (no domain). Please give the details yourself."
        : result.outcome === "SKIPPED" && message.startsWith("DEV_NO_REDIRECT")
          ? "Not sent: this is not production and EMAIL_DEV_REDIRECT is not set."
          : "The email could not be sent. Please give the details yourself.",
  };
}
