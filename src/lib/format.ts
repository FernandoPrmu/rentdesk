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
