/** Display formats. All times are shown in Sri Lanka time (Asia/Colombo). */
export const TIME_ZONE = "Asia/Colombo";

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(value: string | Date): string {
  return dateTime.format(typeof value === "string" ? new Date(value) : value);
}

const dateOnly = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** A calendar date ("2026-10-08", already in Colombo time) -> "8 Oct 2026". */
export function formatDate(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

const counts = new Intl.NumberFormat("en-US");

/** Copies and meter readings: 12500 -> "12,500". */
export function formatCount(value: number): string {
  return counts.format(value);
}
