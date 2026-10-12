import { addDays, addMonths, isIsoDate, type IsoDate } from "../agreements/cycle-calendar.ts";

/**
 * Report date ranges (decision 78): Colombo calendar dates, both ends included,
 * kept in the URL (`?range=last_3_months` or `?range=custom&from=…&to=…`). Pure.
 */

export const RANGE_PRESETS = ["this_month", "last_month", "last_3_months", "last_12_months", "this_year", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const PRESET_LABEL: Record<RangePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
  last_12_months: "Last 12 months",
  this_year: "This year",
  custom: "Choose dates",
};

/** Longest custom range (keeps the report queries and exports small). */
export const MAX_RANGE_DAYS = 3 * 366;

export interface DateRange {
  preset: RangePreset;
  from: IsoDate;
  to: IsoDate;
}

export const monthStart = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;
export const monthEnd = (date: IsoDate): IsoDate => addDays(addMonths(monthStart(date), 1), -1);

export function presetRange(preset: Exclude<RangePreset, "custom">, today: IsoDate): DateRange {
  const start = monthStart(today);
  switch (preset) {
    case "this_month":
      return { preset, from: start, to: today };
    case "last_month":
      return { preset, from: addMonths(start, -1), to: addDays(start, -1) };
    case "last_3_months":
      return { preset, from: addMonths(start, -2), to: today };
    case "last_12_months":
      return { preset, from: addMonths(start, -11), to: today };
    case "this_year":
      return { preset, from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

export interface RangeParams {
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The range in the URL, or the report's default. A custom range must be two real
 * dates, from <= to, at most MAX_RANGE_DAYS long; otherwise `error` explains and the
 * default is used.
 */
export function resolveRange(params: RangeParams, today: IsoDate, fallback: Exclude<RangePreset, "custom"> = "last_3_months"): DateRange & { error?: string } {
  const preset = one(params.range);
  if (preset && preset !== "custom" && (RANGE_PRESETS as readonly string[]).includes(preset)) {
    return presetRange(preset as Exclude<RangePreset, "custom">, today);
  }
  if (preset === "custom") {
    const from = one(params.from) ?? "";
    const to = one(params.to) ?? "";
    let error: string | undefined;
    if (!isIsoDate(from) || !isIsoDate(to)) error = "Please choose both dates.";
    else if (from > to) error = "The start date must be before the end date.";
    else if (addDays(from, MAX_RANGE_DAYS) < to) error = "Please choose at most 3 years.";
    if (!error) return { preset: "custom", from, to };
    return { ...presetRange(fallback, today), error };
  }
  return presetRange(fallback, today);
}

/** The query string for a range ("range=custom&from=…&to=…"). */
export function rangeQuery(range: DateRange): string {
  return range.preset === "custom" ? `range=custom&from=${range.from}&to=${range.to}` : `range=${range.preset}`;
}

const monthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", year: "numeric" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** "2026-10-01" -> "Oct 2026". */
export function monthLabel(month: IsoDate): string {
  return monthFormat.format(new Date(`${month.slice(0, 10)}T00:00:00Z`));
}

/** "1 Aug 2026 – 12 Oct 2026". */
export function rangeLabel(range: Pick<DateRange, "from" | "to">): string {
  const f = (d: IsoDate) => dayFormat.format(new Date(`${d}T00:00:00Z`));
  return range.from === range.to ? f(range.from) : `${f(range.from)} – ${f(range.to)}`;
}

/** Every month that touches the range, as first-of-month dates. */
export function monthsIn(range: Pick<DateRange, "from" | "to">): IsoDate[] {
  const out: IsoDate[] = [];
  for (let m = monthStart(range.from); m <= range.to; m = addMonths(m, 1)) out.push(m);
  return out;
}
