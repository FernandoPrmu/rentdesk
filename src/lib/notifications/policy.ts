import type { Audience, EmailCategory } from "./events.ts";

/**
 * Delivery rules (decisions 68-74), pure so they can be unit-tested.
 * Relative imports only.
 */

/**
 * Production means the real deployment: Vercel's production environment (or
 * APP_ENV=production on another host). `next start` locally, previews and tests
 * are not production, even though NODE_ENV is "production" in a build.
 */
export function isProductionDeployment(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.APP_ENV === "production";
}

/**
 * Email needs a verified sending domain (Resend). Until one is added, production runs
 * with EMAIL_FROM empty and email OFF: every delivery is logged as SKIPPED with this
 * reason and in-app notifications carry on. Setting EMAIL_FROM turns email on with no
 * code change (decision 96). Outside production the redirect rules apply (decision 73).
 */
export const NO_SENDER_DOMAIN = "NO_SENDER_DOMAIN: email is off until a sending domain is set up (EMAIL_FROM is empty); in-app notifications only";

export type EmailSetup = { enabled: true } | { enabled: false; reason: "NO_SENDER_DOMAIN" };

export function emailSetup(env: Record<string, string | undefined> = process.env): EmailSetup {
  return senderDomainMissing({ production: isProductionDeployment(env), fromConfigured: Boolean(env.EMAIL_FROM?.trim()) })
    ? { enabled: false, reason: "NO_SENDER_DOMAIN" }
    : { enabled: true };
}

/** Production without EMAIL_FROM. `fromConfigured` left out = configured (older callers, tests). */
export function senderDomainMissing(config: { production: boolean; fromConfigured?: boolean }): boolean {
  return config.production && config.fromConfigured === false;
}

/** The short line the admin and account screens show while email is off. */
export const EMAIL_OFF_NOTE = "Email is not set up yet (no domain). Give the login details to them yourself.";

export type Destination ={ kind: "send"; to: string; subject: string; devNote: string | null } | { kind: "skip"; reason: string };

/**
 * Outside production every email goes to EMAIL_DEV_REDIRECT, with "[DEV]" in the
 * subject and the real recipient named in the body; without the variable nothing
 * is sent (decision 73).
 */
export function destination(input: { to: string; subject: string; production: boolean; redirect?: string | null }): Destination {
  if (input.production) return { kind: "send", to: input.to, subject: input.subject, devNote: null };
  const redirect = input.redirect?.trim();
  if (!redirect) return { kind: "skip", reason: "DEV_NO_REDIRECT: not production and EMAIL_DEV_REDIRECT is not set, so nothing was sent" };
  return {
    kind: "send",
    to: redirect,
    subject: `[DEV] ${input.subject}`,
    devNote: `Development copy. In production this email would go to ${input.to}.`,
  };
}

export interface Quota {
  sent_today: number;
  sent_month: number;
  daily_limit: number;
  monthly_limit: number;
  reserve: number;
  max_attempts: number;
}

/**
 * How many emails this sender may claim (decision 69). Resend's free tier counts
 * per UTC day and month. Below the reserve everything goes; inside the reserve
 * only essential emails; at a limit, none.
 */
export function emailAllowance(q: Quota, batch: number): { limit: number; essentialOnly: boolean } {
  const leftToday = q.daily_limit - q.sent_today;
  const leftMonth = q.monthly_limit - q.sent_month;
  const left = Math.min(leftToday, leftMonth);
  if (left <= 0) return { limit: 0, essentialOnly: true };
  const essentialOnly = leftToday <= q.reserve || leftMonth <= q.reserve;
  return { limit: Math.min(batch, left), essentialOnly };
}

/** Wait before the next attempt after `attempts` failures: 5 min, 20 min, 80 min, about 5 h, ... */
export function retryDelayMs(attempts: number): number {
  return 5 * 60_000 * 4 ** Math.max(0, attempts - 1);
}

/** A provider error: retry later, give up, or the provider's own quota was reached. */
export type ErrorKind = "retry" | "permanent" | "quota";

export function classifyStatus(status: number | null, message = ""): ErrorKind {
  if (status === null) return "retry"; // network, timeout
  if (status === 429) return /quota|daily|monthly/i.test(message) ? "quota" : "retry";
  if (status >= 500) return "retry";
  return "permanent"; // 4xx: bad address, validation, unverified domain
}

/** Next UTC midnight: when Resend's daily quota starts again. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

const SETTINGS_PATH: Record<Audience, string> = {
  CUSTOMER: "/customer/help/notifications",
  OWNER: "/owner/settings/notifications",
  ADMIN: "/admin/emails",
};

export function preferencesPath(role: Audience): string {
  return SETTINGS_PATH[role];
}

/** Footer line: non-essential emails say how to turn them off. */
export function footerNote(category: EmailCategory, role: Audience, appUrl: string): string | null {
  if (category === "ESSENTIAL" || role === "ADMIN") return null;
  const what = category === "REMINDER" ? "reminder emails" : "update emails";
  return `You can turn off ${what} in RentDesk: ${appUrl}${SETTINGS_PATH[role]}`;
}

/** Absolute link for a notification's in-app path. */
export function absoluteLink(appUrl: string, link: string | null | undefined): string | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  return `${appUrl.replace(/\/+$/, "")}${link.startsWith("/") ? link : `/${link}`}`;
}

/** Sender name: the company for its customers, RentDesk otherwise (decision 72). */
export function senderName(role: Audience, companyName: string | null): string {
  if (role === "CUSTOMER" && companyName) return `${companyName.replace(/["<>\r\n]/g, "").trim()} via RentDesk`;
  return "RentDesk";
}

/** URGENT and HIGH service requests say so first in the subject (client decision, task 10). */
export function withPriority(subject: string, priority: string | undefined): string {
  const p = priority?.trim();
  if (!p) return subject;
  return subject.toUpperCase().startsWith(p.toUpperCase()) ? subject : `${p} ${subject}`;
}
