import { describe, expect, it } from "vitest";

import { acknowledgeBy, daysDown, decideServiceEscalation, escalationHours, SERVICE_DEFAULTS, tonerColoursFor } from "./rules";

describe("toner colours (SRV-06)", () => {
  it("a mono machine gets black automatically", () => {
    expect(tonerColoursFor("TONER", "MONO", [])).toEqual({ ok: true, colours: ["BLACK"] });
    expect(tonerColoursFor("TONER", "MONO", ["BLACK"])).toEqual({ ok: true, colours: ["BLACK"] });
    expect(tonerColoursFor("TONER", "MONO", ["CYAN"])).toEqual({ ok: false, error: "A mono machine uses black toner only" });
  });

  it("a colour machine names at least one colour, in a fixed order, once each", () => {
    expect(tonerColoursFor("TONER", "COLOUR", ["YELLOW", "CYAN", "CYAN"])).toEqual({ ok: true, colours: ["CYAN", "YELLOW"] });
    expect(tonerColoursFor("TONER", "COLOUR", [])).toEqual({ ok: false, error: "Choose the toner colour(s) you need" });
    expect(tonerColoursFor("TONER", "COLOUR", ["GREEN"])).toEqual({ ok: false, error: "Unknown toner colour" });
  });

  it("other request types carry no colours", () => {
    expect(tonerColoursFor("BREAKDOWN", "COLOUR", [])).toEqual({ ok: true, colours: [] });
    expect(tonerColoursFor("SPARE_PART", "MONO", ["BLACK"])).toMatchObject({ ok: false });
  });
});

describe("acknowledgement escalation (SRV-08, decision 61)", () => {
  const created = "2026-10-15T09:00:00+05:30";
  const at = (hours: number) => new Date(new Date(created).getTime() + hours * 3_600_000);
  const decide = (urgency: "LOW" | "NORMAL" | "HIGH" | "URGENT", hours: number, level = 0) =>
    decideServiceEscalation({ created_at: created, urgency, escalation_level: level }, at(hours), SERVICE_DEFAULTS);

  it("URGENT and HIGH use the urgent times (4 h owner, 8 h admin); NORMAL and LOW the normal ones (24 h, 48 h)", () => {
    expect(escalationHours("URGENT", SERVICE_DEFAULTS)).toEqual({ owner: 4, admin: 8 });
    expect(escalationHours("HIGH", SERVICE_DEFAULTS)).toEqual({ owner: 4, admin: 8 });
    expect(escalationHours("NORMAL", SERVICE_DEFAULTS)).toEqual({ owner: 24, admin: 48 });
    expect(escalationHours("LOW", SERVICE_DEFAULTS)).toEqual({ owner: 24, admin: 48 });
    expect(acknowledgeBy(new Date(created), "URGENT", SERVICE_DEFAULTS)).toEqual(at(4));
  });

  it("re-notifies the owner first, then alerts the admin", () => {
    expect(decide("URGENT", 2)).toBeNull();
    expect(decide("URGENT", 4.5)).toEqual({ level: 1, hours: 4 });
    expect(decide("URGENT", 6, 1)).toBeNull();
    expect(decide("URGENT", 8.5, 1)).toEqual({ level: 2, hours: 8 });
    expect(decide("URGENT", 30, 2)).toBeNull();
    expect(decide("NORMAL", 8.5)).toBeNull();
    expect(decide("NORMAL", 25)).toEqual({ level: 1, hours: 25 });
    expect(decide("LOW", 49, 1)).toEqual({ level: 2, hours: 49 });
  });

  it("one daily run: an hour of lookahead, and straight to the admin when both times passed since the last run", () => {
    expect(decide("URGENT", 3.25)).toEqual({ level: 1, hours: 3 }); // within the hour Vercel may fire early
    expect(decide("URGENT", 20)).toEqual({ level: 2, hours: 20 });
  });

  it("an admin time below the owner time never escalates to the admin first", () => {
    const odd = { ...SERVICE_DEFAULTS, service_admin_escalation_hours_urgent: 2 };
    expect(escalationHours("URGENT", odd)).toEqual({ owner: 4, admin: 4 });
  });
});

describe("days down", () => {
  it("counts whole days from raised to resolved (or now)", () => {
    expect(daysDown("2026-10-01T10:00:00Z", "2026-10-04T09:00:00Z")).toBe(2);
    expect(daysDown("2026-10-01T10:00:00Z", null, new Date("2026-10-01T11:00:00Z"))).toBe(0);
  });
});
