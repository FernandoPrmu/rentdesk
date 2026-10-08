/**
 * Terms versions (AGR-02). Same rule as app.open_billing_cycle: the version in
 * force for a cycle is the latest one whose effective cycle has been reached.
 */

export interface VersionLike {
  version: number;
  effective_from_cycle_no: number;
}

export function versionForCycle<T extends VersionLike>(history: T[], cycleNo: number): T | null {
  return (
    history
      .filter((v) => v.effective_from_cycle_no <= cycleNo)
      .sort((a, b) => b.effective_from_cycle_no - a.effective_from_cycle_no || b.version - a.version)[0] ?? null
  );
}

/**
 * Labels for the history table, newest first:
 *   pending    - applies to a cycle that has not been opened yet;
 *   superseded - a later version starts no later, so this one never applies;
 *   inForce    - the terms of the next ticket to be opened.
 */
export function describeVersions<T extends VersionLike>(history: T[], nextCycleNo: number) {
  const next = versionForCycle(history, nextCycleNo);
  return [...history]
    .sort((a, b) => b.version - a.version)
    .map((v) => {
      const superseded = history.some((w) => w.version > v.version && w.effective_from_cycle_no <= v.effective_from_cycle_no);
      return {
        ...v,
        superseded,
        pending: !superseded && v.effective_from_cycle_no > nextCycleNo,
        inForce: next?.version === v.version,
      };
    });
}
