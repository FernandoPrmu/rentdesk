"use client";

import { Eye, FileUp, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { LayoutEditor } from "@/components/settings/layout-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { LETTERHEAD_ACCEPT, LETTERHEAD_MAX_BYTES } from "@/lib/branding/letterhead-limits";
import { clampArea, LAYOUT_PRESETS, type LetterheadLayout, PRESET_HINT, PRESET_LABEL, presetLayout } from "@/lib/invoices/pdf/layout";
import type { InvoiceTemplate, LetterheadFile } from "@/lib/invoices/template";
import { cn } from "@/lib/utils";

/**
 * Settings › Invoice template (BRD-04..07): upload a letterhead, pick a preset
 * or drag the invoice data area, preview a sample invoice with the template as
 * it is on screen, then save. Without a letterhead, invoices use the built-in
 * template with the logo and company details (BRD-06).
 */

type Busy = null | "upload" | "preview" | "save";

const sameLayout = (a: LetterheadLayout, b: LetterheadLayout) => JSON.stringify(a) === JSON.stringify(b);

export function InvoiceTemplateForm({
  initial,
  uploadAction,
  previewAction,
  saveAction,
}: {
  initial: InvoiceTemplate;
  uploadAction: (formData: FormData) => Promise<ActionResult<LetterheadFile & { warning: string | null }>>;
  previewAction: (formData: FormData) => Promise<ActionResult<{ url: string }>>;
  saveAction: (formData: FormData) => Promise<ActionResult>;
}) {
  const [saved, setSaved] = useState(initial);
  const [letterhead, setLetterhead] = useState<LetterheadFile | null>(initial.letterhead);
  const [warning, setWarning] = useState<string | null>(null);
  const [layout, setLayout] = useState<LetterheadLayout>(initial.layout);
  const [instructions, setInstructions] = useState(initial.paymentInstructions ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty =
    (letterhead?.path ?? null) !== (saved.letterhead?.path ?? null) ||
    (letterhead !== null && !sameLayout(layout, saved.layout)) ||
    instructions.trim() !== (saved.paymentInstructions ?? "");

  function templateData(): FormData {
    const fd = new FormData();
    fd.set("letterhead_path", letterhead?.path ?? "");
    fd.set("preset", layout.preset);
    fd.set("area_x", String(layout.area.x));
    fd.set("area_y", String(layout.area.y));
    fd.set("area_w", String(layout.area.w));
    fd.set("area_h", String(layout.area.h));
    fd.set("payment_instructions", instructions);
    return fd;
  }

  function showFailure(result: { error: string; fieldErrors?: Record<string, string> }) {
    setErrors(result.fieldErrors ?? {});
    setFormError(result.error);
  }

  async function upload(file: File) {
    setErrors({});
    setFormError(null);
    if (file.size > LETTERHEAD_MAX_BYTES) {
      setErrors({ letterhead: "The file is too large. The limit is 5 MB." });
      return;
    }
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.set("letterhead", file);
      const result = await uploadAction(fd);
      if (!result.ok) return showFailure(result);
      setLetterhead({ path: result.data.path, kind: result.data.kind, url: result.data.url });
      setWarning(result.data.warning);
      setSampleUrl(null);
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function preview() {
    setErrors({});
    setFormError(null);
    // Open the tab now (inside the tap) so phones do not block it; fill it when the PDF is ready.
    const tab = window.open("", "_blank");
    setBusy("preview");
    try {
      const result = await previewAction(templateData());
      if (!result.ok) {
        tab?.close();
        return showFailure(result);
      }
      setSampleUrl(result.data.url);
      if (tab) tab.location.href = result.data.url;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setErrors({});
    setFormError(null);
    setBusy("save");
    try {
      const result = await saveAction(templateData());
      if (!result.ok) return showFailure(result);
      setSaved({ letterhead, layout, paymentInstructions: instructions.trim() || null });
      toast.success("Invoice template saved");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Letterhead</h2>
            <p className="text-sm text-muted-foreground">
              {letterhead
                ? "Your letterhead is the background of every invoice page."
                : "No letterhead: invoices use the built-in design with your logo and company details."}
            </p>
          </div>
          <input
            ref={fileInput}
            id="field-letterhead"
            type="file"
            name="letterhead"
            accept={LETTERHEAD_ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            data-testid="letterhead-input"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="h-12 gap-2" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
              <FileUp className="size-5" aria-hidden />
              {busy === "upload" ? "Uploading…" : letterhead ? "Replace letterhead" : "Upload letterhead"}
            </Button>
            {letterhead && (
              <Button
                type="button"
                variant="ghost"
                className="h-12 gap-2 text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => {
                  setLetterhead(null);
                  setWarning(null);
                  setSampleUrl(null);
                }}
              >
                <Trash2 className="size-5" aria-hidden /> Remove letterhead
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">An A4 page as a PDF (1 page), JPG or PNG, up to 5 MB.</p>
          {errors.letterhead && <p className="text-sm text-destructive" role="alert">{errors.letterhead}</p>}
          {warning && (
            <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" role="status" data-testid="letterhead-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {warning}
            </p>
          )}
        </CardContent>
      </Card>

      {letterhead && (
        <Card>
          <CardContent className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Where the invoice details go</h2>
              <p className="text-sm text-muted-foreground">Choose a layout, or drag the box. Drag a corner to change its size.</p>
            </div>
            <div role="radiogroup" aria-label="Layout" className="grid gap-2 sm:grid-cols-3">
              {LAYOUT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={layout.preset === p}
                  onClick={() => setLayout(presetLayout(p))}
                  className={cn(
                    "min-h-12 rounded-lg border px-3 py-2 text-left text-sm",
                    layout.preset === p ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted/60",
                  )}
                >
                  {PRESET_LABEL[p]}
                  <span className="block text-xs font-normal text-muted-foreground">{PRESET_HINT[p]}</span>
                </button>
              ))}
            </div>
            {layout.preset === "CUSTOM" && <p className="text-sm text-muted-foreground">Your own position.</p>}
            <LayoutEditor background={letterhead} layout={layout} onChange={setLayout} />
            <details className="rounded-lg border px-3 py-2">
              <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">Exact position (percent of the page)</summary>
              <div className="grid grid-cols-2 gap-3 pb-2">
                {(["x", "y", "w", "h"] as const).map((k) => (
                  <AreaInput key={`${k}-${layout.area[k]}`} name={k} value={layout.area[k]} onCommit={(v) => setLayout({ preset: "CUSTOM", area: clampArea({ ...layout.area, [k]: v }) })} />
                ))}
              </div>
            </details>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-2">
          <Label htmlFor="field-payment_instructions" className="text-sm">
            Payment instructions <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="field-payment_instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={300}
            rows={3}
            aria-invalid={errors.payment_instructions ? true : undefined}
            className="text-base"
          />
          <p className="text-xs text-muted-foreground">Printed under your bank details, for example “Cheques payable to …”. English letters only.</p>
          {errors.payment_instructions && <p className="text-sm text-destructive">{errors.payment_instructions}</p>}
        </CardContent>
      </Card>

      {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-12 gap-2" disabled={busy !== null} onClick={preview}>
          <Eye className="size-5" aria-hidden />
          {busy === "preview" ? "Making the sample…" : "Preview sample invoice"}
        </Button>
        <Button type="button" className="h-12" disabled={busy !== null || !dirty} onClick={save}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </div>
      {dirty && <p className="text-sm text-muted-foreground" data-testid="template-unsaved">You have unsaved changes.</p>}
      {sampleUrl && (
        <p className="text-sm">
          <a href={sampleUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline" data-testid="sample-link">
            Open the sample invoice
          </a>
        </p>
      )}
    </div>
  );
}

const AREA_LABEL = { x: "Left", y: "Top", w: "Width", h: "Height" } as const;

function AreaInput({ name, value, onCommit }: { name: "x" | "y" | "w" | "h"; value: number; onCommit: (v: number) => void }) {
  const id = `field-area-${name}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{AREA_LABEL[name]} (%)</Label>
      <input
        id={id}
        inputMode="decimal"
        defaultValue={String(value)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
          else e.target.value = String(value);
        }}
        className="flex h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </div>
  );
}
