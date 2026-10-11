/**
 * The email layout (NOT-02, BRD-02): a plain, mobile-friendly HTML email with the
 * company's logo and name, the message, one button to open RentDesk and a short
 * footer; and the same content as plain text. Every value is escaped. Inline
 * styles and a single 560 px table, so it reads on phones and in every client.
 * Pure; relative imports only.
 */

export interface EmailContent {
  subject: string;
  /** Plain text: blank lines separate paragraphs. */
  body: string;
  companyName: string;
  /** Content id of the inline logo attachment, when there is one. */
  logoCid?: string | null;
  /** Absolute link for the button. */
  actionUrl?: string | null;
  actionLabel?: string;
  /** Why the reader gets this email and how to turn it off (non-essential emails). */
  footerNote?: string | null;
  /** Non-production only: who it was really for (decision 73). */
  devNote?: string | null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1f2937">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function buildEmail(c: EmailContent): { html: string; text: string } {
  const label = c.actionLabel ?? "Open in RentDesk";
  const dev = c.devNote
    ? `<tr><td style="padding:12px 24px;background:#fef3c7;color:#92400e;font-size:14px;line-height:1.4">${escapeHtml(c.devNote)}</td></tr>`
    : "";
  const logo = c.logoCid
    ? `<img src="cid:${escapeHtml(c.logoCid)}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:8px;object-fit:contain;margin-right:12px">`
    : "";
  const button = c.actionUrl
    ? `<tr><td style="padding:8px 24px 24px"><a href="${escapeHtml(c.actionUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 22px;border-radius:8px">${escapeHtml(label)}</a></td></tr>`
    : "";
  const footer = [c.footerNote, `Sent by ${c.companyName} through RentDesk.`]
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 6px">${escapeHtml(line!)}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
${dev}
<tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td>${logo}</td><td style="font-size:18px;font-weight:700;color:#111827">${escapeHtml(c.companyName)}</td></tr></table></td></tr>
<tr><td style="padding:24px 24px 8px">${paragraphs(c.body)}</td></tr>
${button}
<tr><td style="padding:16px 24px;background:#f9fafb;color:#6b7280;font-size:13px;line-height:1.4">${footer}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    c.devNote ? `${c.devNote}\n` : null,
    c.body.trim(),
    c.actionUrl ? `${label}: ${c.actionUrl}` : null,
    "--",
    c.footerNote ?? null,
    `Sent by ${c.companyName} through RentDesk.`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n\n");

  return { html, text };
}
