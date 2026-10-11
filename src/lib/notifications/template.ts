import { ENGLISH_ONLY_MESSAGE, isEnglishText } from "../text/english.ts";
import { allowedVariables, eventInfo, type VariableName, VARIABLES } from "./events.ts";

/**
 * Email templates (NOT-04, decision 71): plain text with `{variables}`, English
 * only. Built-in defaults live here; the admin's global edits and each owner's
 * overrides are rows in `notification_templates` (owner → global → built-in).
 * Pure: used by the sender, the server action that saves a template and the live
 * preview in the browser. Only relative imports (DB tests run it under Node).
 */

export interface EmailTemplate {
  subject: string;
  body: string;
}

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;

/** `{name}` with a lower-case name; anything else in braces is an error. */
const VARIABLE = /\{([a-z_]+)\}/g;

/** The generic template: the in-app title and text, with a greeting. */
export const GENERIC_TEMPLATE: EmailTemplate = {
  subject: "{title}",
  body: "Hello {recipient_name},\n\n{message}\n\n{company_name}",
};

/** Richer built-in texts for the events customers see most. */
const DEFAULTS: Record<string, EmailTemplate> = {
  "account.credentials": {
    subject: "Your RentDesk login for {company_name}",
    body:
      "Hello {recipient_name},\n\nAn account has been made for you in RentDesk.\n\nUsername: {username}\nTemporary password: {temporary_password}\n\n" +
      "Sign in at {login_url}. The first time you sign in, you will choose your own password. Please do not share these details.\n\n{company_name}",
  },
  "account.contact_changed": {
    subject: "Your email address for {company_name}",
    body:
      "Hello {recipient_name},\n\nThis is a test message. From now on, emails from {company_name} through RentDesk will be sent to {email}.\n\n" +
      "If this is not your address, please tell {company_name}.\n\n{company_name}",
  },
  "ticket.opened": {
    subject: "Meter reading needed: {machine}",
    body:
      "Hello {recipient_name},\n\nIt is time to send the meter reading for {machine}. Open RentDesk, take a photo of the meter with the camera " +
      "and type the reading by {deadline}.\n\nThank you,\n{company_name}",
  },
  "invoice.issued": {
    subject: "Your bill {invoice_no}: {amount}",
    body:
      "Hello {recipient_name},\n\nYour bill {invoice_no} for {machine} is ready: {amount}, due on {due_date}. The bill is attached as a PDF.\n\n" +
      "After you pay, open RentDesk and send the payment slip.\n\nThank you,\n{company_name}",
  },
  "invoice.corrected": {
    subject: "Corrected bill {invoice_no}: {amount}",
    body: "Hello {recipient_name},\n\n{message}\n\nThe corrected bill is attached as a PDF.\n\n{company_name}",
  },
  "invoice.resent": {
    subject: "Your bill {invoice_no}: {amount}",
    body: "Hello {recipient_name},\n\n{message}\n\nThe bill is attached as a PDF.\n\n{company_name}",
  },
  "payment.receipt": {
    subject: "Payment received: {amount}",
    body: "Hello {recipient_name},\n\n{message}\n\nYour receipt is attached as a PDF.\n\nThank you,\n{company_name}",
  },
  "payment.recorded": {
    subject: "Payment recorded: {amount}",
    body: "Hello {recipient_name},\n\n{message}\n\nYour receipt is attached as a PDF.\n\nThank you,\n{company_name}",
  },
  "payment.partial": {
    subject: "Part payment accepted: {amount}",
    body: "Hello {recipient_name},\n\n{message}\n\nYour receipt is attached as a PDF.\n\n{company_name}",
  },
  "service.raised": {
    subject: "{priority}New service request: {customer_name}",
    body: "Hello {recipient_name},\n\n{message}\n\nPlease acknowledge it in RentDesk.",
  },
};

export function defaultTemplate(event: string): EmailTemplate {
  return DEFAULTS[event] ?? GENERIC_TEMPLATE;
}

/** Variable names a text uses (in order, repeated names once). */
export function usedVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((m) => m[1]))];
}

export interface TemplateProblem {
  field: "subject" | "body";
  message: string;
}

/**
 * Checks a template for an event: known variables only, braces only around a
 * variable, required variables kept, one-line subject, lengths. Empty = valid.
 */
export function validateTemplate(event: string, t: EmailTemplate): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const allowed = new Set<string>(allowedVariables(event));
  for (const field of ["subject", "body"] as const) {
    const text = t[field];
    if (text.trim() === "") {
      problems.push({ field, message: field === "subject" ? "Enter a subject." : "Enter the text." });
      continue;
    }
    const unknown = usedVariables(text).filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      problems.push({ field, message: `Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((n) => `{${n}}`).join(", ")}.` });
    }
    if (!isEnglishText(text)) problems.push({ field, message: ENGLISH_ONLY_MESSAGE });
    const stray = text.replace(VARIABLE, "");
    if (/[{}]/.test(stray)) {
      problems.push({ field, message: "Use { } only around a variable name, like {customer_name}." });
    }
  }
  // The subject is kept in the delivery log; the password must never reach it.
  if (usedVariables(t.subject).includes("temporary_password")) {
    problems.push({ field: "subject", message: "Do not put the password in the subject: subjects are kept in the delivery log." });
  }
  if (/[\r\n]/.test(t.subject)) problems.push({ field: "subject", message: "The subject must be one line." });
  if (t.subject.length > SUBJECT_MAX) problems.push({ field: "subject", message: `Keep the subject under ${SUBJECT_MAX} characters.` });
  if (t.body.length > BODY_MAX) problems.push({ field: "body", message: `Keep the text under ${BODY_MAX} characters.` });
  const required = eventInfo(event)?.required ?? [];
  const both = `${t.subject}\n${t.body}`;
  const missing = required.filter((name) => !usedVariables(both).includes(name));
  if (missing.length > 0) {
    problems.push({ field: "body", message: `Keep ${missing.map((n) => `{${n}}`).join(" and ")}: this email is useless without it.` });
  }
  return problems;
}

export type RenderResult = { ok: true; subject: string; body: string } | { ok: false; missing: string[] };

/** Fills the variables. A variable this message has no value for makes it fail (the caller falls back); an empty value is fine. */
export function renderTemplate(t: EmailTemplate, vars: Record<string, string | undefined>): RenderResult {
  const missing = new Set<string>();
  const fill = (text: string) =>
    text.replace(VARIABLE, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) {
        missing.add(name);
        return "";
      }
      return value;
    });
  const subject = fill(t.subject).replace(/\s+/g, " ").trim();
  const body = fill(t.body).replace(/\n{3,}/g, "\n\n").trim();
  return missing.size > 0 ? { ok: false, missing: [...missing] } : { ok: true, subject, body };
}

/**
 * The email for one message: the effective template, else the built-in default,
 * else the generic one when a variable is missing (e.g. a message written in SQL
 * that has only {title} and {message}). The generic template always renders.
 */
export function renderEmail(
  event: string,
  template: EmailTemplate | null,
  vars: Record<string, string | undefined>,
): { subject: string; body: string; source: "template" | "default" | "generic" } {
  if (template) {
    const r = renderTemplate(template, vars);
    if (r.ok) return { subject: r.subject, body: r.body, source: "template" };
  }
  const builtIn = renderTemplate(defaultTemplate(event), vars);
  if (builtIn.ok) return { subject: builtIn.subject, body: builtIn.body, source: "default" };
  const generic = renderTemplate(GENERIC_TEMPLATE, {
    ...vars,
    recipient_name: vars.recipient_name || "there",
    company_name: vars.company_name || "RentDesk",
    title: vars.title || "RentDesk",
    message: vars.message || " ",
  });
  return { subject: generic.ok ? generic.subject : "RentDesk", body: generic.ok ? generic.body : "", source: "generic" };
}

/** Preview values: every variable of the event, from the samples. */
export function sampleVariables(event: string, overrides: Partial<Record<VariableName, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowedVariables(event)) out[name] = overrides[name] ?? VARIABLES[name].sample;
  return out;
}
