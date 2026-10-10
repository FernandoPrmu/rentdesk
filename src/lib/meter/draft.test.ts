import { describe, expect, it } from "vitest";

import { clearDraft, draftKey, type DraftStorage, loadDraft, saveDraft } from "./draft";

const KEY = "0b7c8a2e-4f1d-4c3a-9e2b-5d6f7a8b9c0d";
const TICKET = "ticket-1";
const NOW = new Date("2026-10-11T10:00:00Z");

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const broken: DraftStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("meter draft on the device (rule 31)", () => {
  it("keeps the typed readings and the submission key across a reload", () => {
    const s = memory();
    saveDraft(s, TICKET, { bw: "12,500", colour: "", idempotencyKey: KEY }, NOW);
    expect(loadDraft(s, TICKET, NOW)).toEqual({ bw: "12,500", colour: "", idempotencyKey: KEY, savedAt: NOW.toISOString() });
    expect(loadDraft(s, "another-ticket", NOW)).toBeNull();
  });

  it("is cleared after a successful send", () => {
    const s = memory();
    saveDraft(s, TICKET, { bw: "1", colour: "", idempotencyKey: KEY }, NOW);
    clearDraft(s, TICKET);
    expect(loadDraft(s, TICKET, NOW)).toBeNull();
  });

  it("ignores broken, tampered or stale drafts", () => {
    const s = memory();
    s.data.set(draftKey(TICKET), "{not json");
    expect(loadDraft(s, TICKET, NOW)).toBeNull();
    s.data.set(draftKey(TICKET), JSON.stringify({ bw: "1", idempotencyKey: "not-a-uuid", savedAt: NOW.toISOString() }));
    expect(loadDraft(s, TICKET, NOW)).toBeNull();
    s.data.set(draftKey(TICKET), JSON.stringify({ bw: 5, colour: null, idempotencyKey: KEY, savedAt: NOW.toISOString() }));
    expect(loadDraft(s, TICKET, NOW)).toMatchObject({ bw: "", colour: "" });
    saveDraft(s, TICKET, { bw: "1", colour: "", idempotencyKey: KEY }, new Date("2026-06-01T00:00:00Z"));
    expect(loadDraft(s, TICKET, NOW)).toBeNull();
  });

  it("works without storage (private mode, blocked site data)", () => {
    expect(() => saveDraft(broken, TICKET, { bw: "1", colour: "", idempotencyKey: KEY }, NOW)).not.toThrow();
    expect(loadDraft(broken, TICKET, NOW)).toBeNull();
    expect(() => clearDraft(broken, TICKET)).not.toThrow();
    expect(loadDraft(null, TICKET, NOW)).toBeNull();
  });
});
