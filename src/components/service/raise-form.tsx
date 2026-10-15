"use client";

import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { FormField } from "@/components/forms/form-field";
import { useHydrated } from "@/components/forms/use-hydrated";
import { SlipPicker, type UploadedSlip } from "@/components/payments/slip-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { RaiseInput } from "@/lib/service/schemas";
import type { RentedMachine } from "@/lib/service/service";
import { COLOUR_LABEL, isPriority, SERVICE_TYPES, type ServiceType, TONER_COLOURS, type TonerColour, TYPE_LABEL, URGENCIES, type Urgency, URGENCY_LABEL } from "@/lib/service/states";
import { cn } from "@/lib/utils";

/**
 * SRV-01, SRV-02, SRV-06, CP-07: the customer asks for service on one of their
 * machines, in a few taps: the machine, what is needed (toner colours for a colour
 * machine; a mono machine gets black), what is wrong, how urgent, a preferred date
 * and an optional photo (camera or gallery, decision 58). The key makes a retry
 * return the first request (never two).
 */

const TYPE_HINT: Record<ServiceType, string> = {
  BREAKDOWN: "Stopped, error code, jams",
  TONER: "Toner low or empty",
  SPARE_PART: "Drum, roller, fuser…",
  MAINTENANCE: "Routine service, cleaning",
  OTHER: "Anything else",
};

const choice = (active: boolean) =>
  cn("min-h-12 rounded-lg border px-3 py-2 text-left text-base transition-colors", active ? "border-primary bg-primary/10 font-semibold" : "bg-background");

export function RaiseForm({
  machines,
  ownerId,
  customerId,
  initialMachineId,
  initialType,
  today,
  action,
}: {
  machines: RentedMachine[];
  ownerId: string;
  customerId: string;
  initialMachineId?: string;
  initialType?: ServiceType;
  today: string;
  action: (input: RaiseInput) => Promise<ActionResult<{ requestId: string; replayed: boolean }>>;
}) {
  const [machineId, setMachineId] = useState(initialMachineId && machines.some((m) => m.id === initialMachineId) ? initialMachineId : machines.length === 1 ? machines[0].id : "");
  const [type, setType] = useState<ServiceType | "">(initialType ?? "");
  const [colours, setColours] = useState<TonerColour[]>([]);
  const [partName, setPartName] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("NORMAL");
  const [preferredDate, setPreferredDate] = useState("");
  const [photo, setPhoto] = useState<UploadedSlip | null>(null);
  const [uploading, setUploading] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hydrated = useHydrated();

  const machine = machines.find((m) => m.id === machineId);
  const colourMachine = machine?.type === "COLOUR";

  if (sent) {
    return (
      <div className="space-y-5 py-4 text-center" data-testid="service-sent">
        <CircleCheck className="mx-auto size-16 text-primary" aria-hidden />
        <h1 className="text-2xl font-bold">Request sent</h1>
        <p className="text-muted-foreground">
          Your rental company has been told{isPriority(urgency) ? " and sees it as urgent" : ""}. You will get a message at every step.
        </p>
        <Link href={`/customer/service/${sent}`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
          Open the request
        </Link>
        <Link href="/customer" className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full text-base")}>
          Back to Home
        </Link>
      </div>
    );
  }

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!machineId) e.machineId = "Choose the machine.";
    if (!type) e.type = "Choose what you need.";
    if (type === "TONER" && colourMachine && colours.length === 0) e.tonerColours = "Choose the toner colour(s) you need.";
    if (!description.trim()) e.description = "Tell your rental company what is wrong or what you need.";
    return e;
  }

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) return setMessage("Please check the fields marked in red.");
        if (uploading) return setMessage("Wait for the photo to finish uploading, then tap Send.");
        start(async () => {
          try {
            const result = await action({
              idempotencyKey: key,
              machineId,
              type: type as ServiceType,
              urgency,
              description,
              tonerColours: type === "TONER" ? (colourMachine ? colours : ["BLACK"]) : [],
              partName: type === "SPARE_PART" ? partName : undefined,
              preferredDate: preferredDate || undefined,
              photoPath: photo?.path ?? null,
            });
            if (result.ok) return setSent(result.data.requestId);
            setErrors(result.fieldErrors ?? {});
            setMessage(result.error);
          } catch {
            // The same key goes with the retry, so the server returns this request if it did arrive.
            setMessage("We could not confirm that your request was sent (the connection was lost). Tap Send again: it is never sent twice.");
          }
        });
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">Which machine?</legend>
        {machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no machines rented right now.</p>
        ) : (
          <div className="grid gap-2" role="radiogroup" aria-label="Machine">
            {machines.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={machineId === m.id} className={choice(machineId === m.id)} onClick={() => setMachineId(m.id)}>
                <span className="block">{m.name}</span>
                <span className="block text-sm font-normal text-muted-foreground">
                  {m.serialNo}
                  {m.location ? ` · ${m.location}` : ""} · {m.type === "COLOUR" ? "colour" : "black & white"}
                </span>
              </button>
            ))}
          </div>
        )}
        {errors.machineId && <p className="text-sm text-destructive">{errors.machineId}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">What do you need?</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Request type">
          {SERVICE_TYPES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} className={choice(type === t)} onClick={() => setType(t)}>
              <span className="block">{TYPE_LABEL[t]}</span>
              <span className="block text-xs font-normal text-muted-foreground">{TYPE_HINT[t]}</span>
            </button>
          ))}
        </div>
        {errors.type && <p className="text-sm text-destructive">{errors.type}</p>}
      </fieldset>

      {type === "TONER" && machine && (
        <fieldset className="space-y-2" data-testid="toner-colours">
          <legend className="text-base font-semibold">Which toner?</legend>
          {colourMachine ? (
            <div className="grid grid-cols-2 gap-2">
              {TONER_COLOURS.map((c) => {
                const on = colours.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={choice(on)}
                    onClick={() => setColours(on ? colours.filter((x) => x !== c) : [...colours, c])}
                  >
                    <span className={cn("mr-2 inline-block size-3 rounded-full border align-middle", { BLACK: "bg-black", CYAN: "bg-cyan-500", MAGENTA: "bg-fuchsia-600", YELLOW: "bg-yellow-400" }[c])} aria-hidden />
                    {COLOUR_LABEL[c]}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm">Black toner (this machine prints black &amp; white only).</p>
          )}
          {errors.tonerColours && <p className="text-sm text-destructive">{errors.tonerColours}</p>}
        </fieldset>
      )}

      {type === "SPARE_PART" && (
        <FormField name="partName" label="Which part?" value={partName} onChange={setPartName} error={errors.partName} hint="For example: drum unit, fuser, paper tray roller." />
      )}

      <div className="space-y-1.5">
        <Label htmlFor="service-description" className="text-base font-semibold">
          {type === "BREAKDOWN" ? "What is wrong?" : "Tell us more"}
        </Label>
        <Textarea
          id="service-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={1000}
          className="text-base"
          placeholder={type === "BREAKDOWN" ? "For example: error E-201 and paper jams in tray 2" : "For example: cyan is nearly empty"}
          aria-invalid={Boolean(errors.description)}
        />
        {errors.description && <p className="text-sm text-destructive">{errors.description}</p>}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">How urgent?</legend>
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Urgency">
          {URGENCIES.map((u) => (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={urgency === u}
              className={cn(
                "min-h-12 rounded-lg border text-sm",
                urgency === u ? (u === "URGENT" ? "border-red-600 bg-red-600 font-semibold text-white" : u === "HIGH" ? "border-orange-700 bg-orange-700 font-semibold text-white" : "border-primary bg-primary/10 font-semibold") : "bg-background",
              )}
              onClick={() => setUrgency(u)}
            >
              {URGENCY_LABEL[u]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Urgent: the machine cannot be used at all.</p>
      </fieldset>

      <FormField name="preferredDate" label="Preferred date" type="date" min={today} value={preferredDate} onChange={setPreferredDate} error={errors.preferredDate} hint="When a visit suits you best." />

      <SlipPicker
        ownerId={ownerId}
        customerId={customerId}
        value={photo}
        onChange={setPhoto}
        onUploadingChange={setUploading}
        error={errors.photo}
        bucket="service-photos"
        imagesOnly
        label="Photo of the problem (optional)"
        hint="For example the error on the screen or the damaged part. Camera or gallery, up to 5 MB."
      />

      {message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-14 w-full text-lg" disabled={pending || !hydrated || uploading || machines.length === 0}>
        {pending ? "Sending…" : uploading ? "Uploading the photo…" : "Send request"}
      </Button>
    </form>
  );
}
