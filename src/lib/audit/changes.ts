/** Pure helpers for the audit log viewer (ADM-05). */

/** Old -> new rows from an audit entry (`details.changes` of UPDATE / STATUS_CHANGE entries). */
export function auditChanges(details: Record<string, unknown>): { field: string; old: unknown; new: unknown }[] {
  const changes = details.changes;
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, unknown>).map(([field, pair]) =>
    Array.isArray(pair) && pair.length === 2 ? { field, old: pair[0], new: pair[1] } : { field, old: null, new: pair },
  );
}

/** A value as text for the old / new columns. */
export function auditValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
