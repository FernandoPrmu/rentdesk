import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { EVENTS, isCatalogEvent } from "@/lib/notifications/events";
import { LOG_CHANNELS, LOG_STATUSES, type LogFilter, type LogRow } from "@/lib/notifications/queries";

const STATUS_LABEL: Record<string, string> = { PENDING: "Pending", SENT: "Sent", FAILED: "Failed", SKIPPED: "Skipped", READ: "Read" };
const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  SENT: "secondary",
  READ: "default",
  FAILED: "destructive",
  SKIPPED: "outline",
};
const CHANNEL_LABEL: Record<string, string> = { IN_APP: "In-app", EMAIL: "Email", SMS: "SMS", WHATSAPP: "WhatsApp" };

const eventLabel = (event: string) => (isCatalogEvent(event) ? EVENTS[event].label : event);

const KNOWN_REASON: Record<string, string> = {
  NO_EMAIL: "No email address",
  NO_PHONE: "No phone number",
  OPTED_OUT: "Turned off by the user",
  EXPIRED: "Reminder too old, not sent",
  DEFERRED: "Waiting: daily email limit",
  WAITING_FOR_PDF: "Waiting for the PDF",
  DEV_NO_REDIRECT: "Not sent (development)",
  NOT_CONFIGURED: "Email is not set up",
  NO_PROVIDER: "No SMS or WhatsApp provider yet",
};

/** Why a delivery was skipped, waits or failed, in plain words (the code stays in the database). */
export function logReason(lastError: string | null): string | null {
  if (!lastError) return null;
  const code = lastError.split(":")[0];
  if (code === "DEV") return `Development copy: ${lastError.slice(5)}`;
  return KNOWN_REASON[code] ?? lastError;
}

/** Delivery log (NOT-05, ADM-05): one row per notification and channel. */
export function DeliveryLog({
  rows,
  more,
  filter,
  path,
  owners,
}: {
  rows: LogRow[];
  more: boolean;
  filter: LogFilter;
  path: string;
  /** Admin: filter by owner. */
  owners?: { id: string; name: string }[];
}) {
  const ownerName = new Map((owners ?? []).map((o) => [o.id, o.name]));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v && k !== "before") params.set(k, String(v));
  const last = rows[rows.length - 1];
  if (last) params.set("before", last.createdAt);
  const nextHref = `${path}?${params}`;

  return (
    <div className="space-y-4">
      <form method="get" role="search" className="grid gap-2 sm:grid-cols-4" key={JSON.stringify(filter)}>
        <ChoiceSelect name="status" ariaLabel="Status" defaultValue={filter.status ?? ""} emptyLabel="Any status" options={LOG_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        <ChoiceSelect name="channel" ariaLabel="Channel" defaultValue={filter.channel ?? ""} emptyLabel="Any channel" options={LOG_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} />
        {owners && <ChoiceSelect name="owner" ariaLabel="Owner" defaultValue={filter.owner ?? ""} emptyLabel="Any owner" options={owners.map((o) => ({ value: o.id, label: o.name }))} />}
        <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
          Show
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border bg-background px-4 py-8 text-center text-muted-foreground">Nothing in the log for this filter.</p>
      ) : (
        <>
          {/* Cards on phones */}
          <ul className="space-y-2 md:hidden" aria-label="Deliveries">
            {rows.map((r) => (
              <li key={`${r.channel}-${r.id}`} className="rounded-xl border bg-background p-3" data-testid="log-row">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                  <Badge variant="outline">{CHANNEL_LABEL[r.channel] ?? r.channel}</Badge>
                  {r.attempts > 1 && <span className="text-xs text-muted-foreground">{r.attempts} attempts</span>}
                </div>
                <p className="mt-1.5 font-medium break-words">{r.title}</p>
                <p className="text-sm break-words text-muted-foreground">
                  {r.userName}
                  {r.recipient ? ` · ${r.recipient}` : ""}
                  {owners && r.ownerId ? ` · ${ownerName.get(r.ownerId) ?? ""}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {eventLabel(r.event)} · {formatDateTime(r.createdAt)}
                </p>
                {logReason(r.lastError) && <p className="mt-1 text-sm break-words">{logReason(r.lastError)}</p>}
              </li>
            ))}
          </ul>
          {/* Table on larger screens */}
          <div className="hidden overflow-x-auto rounded-xl border bg-background md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Message</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={`${r.channel}-${r.id}`} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                    <td className="px-3 py-2">
                      {r.userName}
                      {r.recipient && <span className="block text-xs text-muted-foreground">{r.recipient}</span>}
                      {owners && r.ownerId && <span className="block text-xs text-muted-foreground">{ownerName.get(r.ownerId)}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {r.title}
                      <span className="block text-xs text-muted-foreground">{eventLabel(r.event)}</span>
                    </td>
                    <td className="px-3 py-2">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                    </td>
                    <td className="px-3 py-2">{r.attempts}</td>
                    <td className="max-w-64 px-3 py-2 break-words">{logReason(r.lastError)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more && (
            <Link href={nextHref} className="flex h-12 items-center justify-center rounded-lg border bg-background font-medium hover:bg-muted">
              Show older
            </Link>
          )}
        </>
      )}
    </div>
  );
}
