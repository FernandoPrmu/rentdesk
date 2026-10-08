import { describe, expect, it } from "vitest";

import { describeVersions, versionForCycle } from "./terms";

const history = [
  { version: 1, effective_from_cycle_no: 1 },
  { version: 2, effective_from_cycle_no: 4 },
  { version: 3, effective_from_cycle_no: 6 },
  { version: 4, effective_from_cycle_no: 6 }, // edited again before cycle 6
];

describe("versionForCycle", () => {
  it("picks the latest version whose effective cycle has been reached", () => {
    expect(versionForCycle(history, 1)?.version).toBe(1);
    expect(versionForCycle(history, 3)?.version).toBe(1);
    expect(versionForCycle(history, 4)?.version).toBe(2);
    expect(versionForCycle(history, 6)?.version).toBe(4);
    expect(versionForCycle(history, 99)?.version).toBe(4);
    expect(versionForCycle([], 1)).toBeNull();
  });
});

describe("describeVersions", () => {
  it("labels pending, superseded and in-force versions", () => {
    const rows = describeVersions(history, 5);
    expect(rows.map((r) => [r.version, r.pending, r.superseded, r.inForce])).toEqual([
      [4, true, false, false],
      [3, false, true, false],
      [2, false, false, true],
      [1, false, false, false],
    ]);
  });
});
