"use client";

import { RotateCcw } from "lucide-react";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { resetTemplateAction, saveTemplateAction } from "@/app/actions/notifications";
import { FormError } from "@/components/forms/form-field";
import { useFormAction } from "@/components/forms/use-form-action";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { unreachable } from "@/lib/actions/client-errors";
import { buildEmail } from "@/lib/notifications/email-html";
import { allowedVariables, type VariableName, VARIABLES } from "@/lib/notifications/events";
import { type EmailTemplate, renderTemplate, sampleVariables, validateTemplate } from "@/lib/notifications/template";

/**
 * Edits one email template (NOT-04, decision 71): subject and text with
 * {variables}, tap a variable to insert it, a live preview with sample values and
 * the company's logo, problems shown as you type (the server checks again), and
 * "Reset to default".
 */
export function TemplateEditor({
  event,
  initial,
  inherited,
  inheritedLabel,
  hasOwn,
  companyName,
  logoUrl,
}: {
  event: string;
  initial: EmailTemplate;
  /** What applies after a reset. */
  inherited: EmailTemplate;
  inheritedLabel: string;
  hasOwn: boolean;
  companyName: string;
  logoUrl: string | null;
}) {
  const hydrated = useHydrated();
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [resetting, startReset] = useTransition();
  const focused = useRef<{ field: "subject" | "body"; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { onSubmit, pending, errors, formError } = useFormAction(saveTemplateAction.bind(null, event), () => toast.success("Template saved"));

  const problems = useMemo(() => validateTemplate(event, { subject, body }), [event, subject, body]);
  const live: Record<string, string> = {};
  for (const p of problems) live[p.field] ??= p.message;
  const shown = { subject: errors.subject ?? live.subject, body: errors.body ?? live.body };

  const preview = useMemo(() => {
    const vars = sampleVariables(event, { company_name: companyName });
    const r = renderTemplate({ subject, body }, vars);
    if (!r.ok) return null;
    return { subject: r.subject, html: buildEmail({ subject: r.subject, body: r.body, companyName, logoSrc: logoUrl, actionUrl: vars.link }).html };
  }, [event, subject, body, companyName, logoUrl]);

  const insert = (name: VariableName) => {
    const target = focused.current ?? { field: "body" as const, el: bodyRef.current! };
    const el = target.el;
    const value = target.field === "subject" ? subject : body;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}{${name}}${value.slice(end)}`;
    if (target.field === "subject") setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const at = start + name.length + 2;
      el.setSelectionRange(at, at);
    });
  };

  const reset = () =>
    startReset(async () => {
      try {
        const result = await resetTemplateAction(event);
        if (!result.ok) return void toast.error(result.error);
        setSubject(inherited.subject);
        setBody(inherited.body);
        toast.success("Back to the default text");
      } catch {
        toast.error(unreachable("safe"));
      }
    });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="template-subject">Subject</Label>
          <Input
            id="template-subject"
            ref={subjectRef}
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onFocus={(e) => (focused.current = { field: "subject", el: e.currentTarget })}
            aria-invalid={shown.subject ? true : undefined}
            aria-describedby={shown.subject ? "template-subject-error" : undefined}
            className="h-12 text-base"
          />
          {shown.subject && (
            <p id="template-subject-error" className="text-sm text-destructive">
              {shown.subject}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="template-body">Text</Label>
          <Textarea
            id="template-body"
            ref={bodyRef}
            name="body"
            value={body}
            rows={10}
            onChange={(e) => setBody(e.target.value)}
            onFocus={(e) => (focused.current = { field: "body", el: e.currentTarget })}
            aria-invalid={shown.body ? true : undefined}
            aria-describedby={shown.body ? "template-body-error" : "template-body-hint"}
            className="min-h-56 text-base"
          />
          {shown.body ? (
            <p id="template-body-error" className="text-sm text-destructive">
              {shown.body}
            </p>
          ) : (
            <p id="template-body-hint" className="text-xs text-muted-foreground">
              A blank line starts a new paragraph. English only.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Variables (tap to insert)</p>
          <ul className="flex flex-wrap gap-2" aria-label="Variables">
            {allowedVariables(event).map((name) => (
              <li key={name}>
                <button
                  type="button"
                  title={VARIABLES[name].label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(name)}
                  className="h-10 rounded-full border bg-background px-3 font-mono text-sm hover:bg-muted"
                >
                  {`{${name}}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <FormError message={formError} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" className="h-12 text-base sm:px-8" disabled={!hydrated || pending || problems.length > 0}>
            {pending ? "Saving…" : "Save template"}
          </Button>
          {hasOwn && (
            <Button type="button" variant="outline" className="h-12 gap-2 text-base" disabled={!hydrated || resetting} onClick={reset}>
              <RotateCcw className="size-4" aria-hidden /> {resetting ? "Resetting…" : "Reset to default"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Without your own text: {inheritedLabel}.</p>
      </form>

      <section aria-label="Preview" className="space-y-2">
        <h2 className="text-sm font-medium">Preview with sample details</h2>
        {preview ? (
          <>
            <p className="rounded-md border bg-background px-3 py-2 text-sm" data-testid="preview-subject">
              <span className="text-muted-foreground">Subject: </span>
              {preview.subject}
            </p>
            <iframe
              title="Email preview"
              data-testid="email-preview"
              sandbox=""
              srcDoc={preview.html}
              className="h-[32rem] w-full rounded-lg border bg-white"
            />
          </>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Fix the text to see the preview.</p>
        )}
      </section>
    </div>
  );
}
