/**
 * The customer's meter entry draft (INV-13, decisions.md rule 31): the typed
 * readings and the submission's idempotency key, kept on the device per ticket so
 * a refresh or a lost connection loses nothing and a retry never creates a second
 * submission. The photo is never stored. Storage may be missing or throw (private
 * mode, blocked site data): then the page simply works without a draft.
 */

export interface MeterDraft {
  bw: string;
  colour: string;
  idempotencyKey: string;
  savedAt: string;
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "rentdesk:meter-draft:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A draft older than this is dropped (its ticket has long moved on). */
const MAX_AGE_MS = 60 * 86_400_000;

export const draftKey = (ticketId: string) => `${PREFIX}${ticketId}`;

export function loadDraft(storage: DraftStorage | null, ticketId: string, now: Date = new Date()): MeterDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftKey(ticketId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<MeterDraft>;
    if (typeof d.idempotencyKey !== "string" || !UUID.test(d.idempotencyKey)) return null;
    const saved = Date.parse(d.savedAt ?? "");
    if (Number.isNaN(saved) || now.getTime() - saved > MAX_AGE_MS) return null;
    return {
      bw: typeof d.bw === "string" ? d.bw : "",
      colour: typeof d.colour === "string" ? d.colour : "",
      idempotencyKey: d.idempotencyKey,
      savedAt: d.savedAt!,
    };
  } catch {
    return null;
  }
}

export function saveDraft(storage: DraftStorage | null, ticketId: string, draft: Omit<MeterDraft, "savedAt">, now: Date = new Date()): void {
  if (!storage) return;
  try {
    storage.setItem(draftKey(ticketId), JSON.stringify({ ...draft, savedAt: now.toISOString() }));
  } catch {
    // Full or blocked storage: the draft is only a convenience.
  }
}

export function clearDraft(storage: DraftStorage | null, ticketId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(ticketId));
  } catch {
    // Nothing to do.
  }
}

/** localStorage when the browser allows it. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
