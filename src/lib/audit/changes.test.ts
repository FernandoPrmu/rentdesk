import { describe, expect, it } from "vitest";

import { auditChanges, auditValue } from "./changes";

describe("audit entry changes (ADM-05)", () => {
  it("old -> new pairs from the audit trigger's diff", () => {
    expect(auditChanges({ changes: { meter_deadline_days: [5, 6], meter_reminder_days: [[2, 4], [2, 5]] } })).toEqual([
      { field: "meter_deadline_days", old: 5, new: 6 },
      { field: "meter_reminder_days", old: [2, 4], new: [2, 5] },
    ]);
    expect(auditChanges({ new: { id: 1 } })).toEqual([]);
    expect(auditChanges({ changes: "x" })).toEqual([]);
  });

  it("values as text", () => {
    expect(auditValue(null)).toBe("—");
    expect(auditValue("ACTIVE")).toBe("ACTIVE");
    expect(auditValue([2, 4])).toBe("[2,4]");
    expect(auditValue(false)).toBe("false");
  });
});
