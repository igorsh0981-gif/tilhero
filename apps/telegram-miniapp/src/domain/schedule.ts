import type { DurationMin, Schedule, SchedulePreset } from "@tilhero/contracts/bff";

/**
 * Learning schedule (APP-ONB-03, AT-06): days of the week (ISO 1=Mon … 7=Sun), a time "HH:MM" in the plan's time
 * zone, a duration of 10/15/20/30 minutes and an explicit opt-in for reminders. Pure functions — the onboarding step
 * and the profile editor share them.
 */
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const PRESETS: readonly SchedulePreset[] = ["daily", "weekdays", "three_per_week", "custom"];
export const PRESET_DAYS: Readonly<Record<Exclude<SchedulePreset, "custom">, readonly number[]>> = {
  daily: [1, 2, 3, 4, 5, 6, 7],
  weekdays: [1, 2, 3, 4, 5],
  three_per_week: [1, 3, 5],
};
export const DURATIONS: readonly DurationMin[] = [10, 15, 20, 30];
export type TimeChoice = "morning" | "day" | "evening" | "custom";
/** client presets (bff.ts Schedule.preferred_time): morning 08:00, day 13:00, evening 19:00 */
export const TIME_PRESETS: Readonly<Record<Exclude<TimeChoice, "custom">, string>> = { morning: "08:00", day: "13:00", evening: "19:00" };
export const TIME_CHOICES: readonly TimeChoice[] = ["morning", "day", "evening", "custom"];
export const DEFAULT_TZ = "Asia/Tashkent";
/** zones offered besides the device zone (Uzbekistan and neighbours first) */
export const COMMON_ZONES = ["Asia/Tashkent", "Asia/Samarkand", "Asia/Almaty", "Asia/Bishkek", "Asia/Dushanbe", "Europe/Moscow", "Asia/Dubai", "Europe/Istanbul"];

/** ISO days, integers 1..7, ascending, without repeats. */
export function normalizeDays(days: readonly unknown[]): number[] {
  const set = new Set<number>();
  for (const d of days) if (typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7) set.add(d);
  return [...set].sort((a, b) => a - b);
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The preset the days are equal to; anything else is "custom". */
export function presetForDays(days: readonly number[]): SchedulePreset {
  const d = normalizeDays(days);
  for (const p of ["daily", "weekdays", "three_per_week"] as const) if (sameDays(d, PRESET_DAYS[p])) return p;
  return "custom";
}

/** Choosing a preset: its days; "custom" keeps the current days (or Mon/Wed/Fri when none). */
export function choosePreset(s: Pick<Schedule, "preset" | "days">, preset: SchedulePreset): Pick<Schedule, "preset" | "days"> {
  if (preset === "custom") return { preset, days: s.days.length ? normalizeDays(s.days) : [...PRESET_DAYS.three_per_week] };
  return { preset, days: [...PRESET_DAYS[preset]] };
}

/** Toggling one day turns the choice into the matching preset or "custom"; the last day cannot be removed. */
export function toggleDay(s: Pick<Schedule, "preset" | "days">, day: number): Pick<Schedule, "preset" | "days"> {
  const cur = normalizeDays(s.days);
  const next = cur.includes(day) ? cur.filter((d) => d !== day) : normalizeDays([...cur, day]);
  if (next.length === 0) return { preset: s.preset, days: cur };
  return { preset: presetForDays(next), days: next };
}

export function isValidTime(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function timeChoice(time: string): TimeChoice {
  for (const k of ["morning", "day", "evening"] as const) if (TIME_PRESETS[k] === time) return k;
  return "custom";
}

export function isDuration(v: unknown): v is DurationMin {
  return v === 10 || v === 15 || v === 20 || v === 30;
}

/** IANA zone check through Intl (unknown zones throw RangeError). */
export function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The device time zone (Intl), Asia/Tashkent when unknown. */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Zones for the picker: the current one, the device one, then the common list — without repeats. */
export function zoneOptions(current: string, device: string): string[] {
  const out: string[] = [];
  for (const z of [current, device, ...COMMON_ZONES]) if (isValidZone(z) && !out.includes(z)) out.push(z);
  return out;
}

/** UTC offset of a zone right now, e.g. "UTC+5" / "UTC+5:30" / "UTC". */
export function utcOffset(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /^GMT([+-]\d{1,2}(?::\d{2})?)?$/.exec(name);
    if (!m) return "";
    return m[1] && !/^[+-]0(:00)?$/.test(m[1]) ? `UTC${m[1]}` : "UTC";
  } catch {
    return "";
  }
}

/** Validation for saving: returns the first invalid field or null. */
export function scheduleProblem(s: Schedule): "days" | "preferred_time" | "duration_min" | "timezone" | null {
  if (normalizeDays(s.days).length === 0) return "days";
  if (!isValidTime(s.preferred_time)) return "preferred_time";
  if (!isDuration(s.duration_min)) return "duration_min";
  if (!isValidZone(s.timezone)) return "timezone";
  return null;
}

/** Only the changed fields (PATCH /v1/plan {schedule}). */
export function scheduleDiff(before: Schedule, after: Schedule): Partial<Schedule> {
  const out: Partial<Schedule> = {};
  if (before.preset !== after.preset) out.preset = after.preset;
  if (!sameDays(normalizeDays(before.days), normalizeDays(after.days))) out.days = normalizeDays(after.days);
  if (before.preferred_time !== after.preferred_time) out.preferred_time = after.preferred_time;
  if (before.duration_min !== after.duration_min) out.duration_min = after.duration_min;
  if (before.reminders_enabled !== after.reminders_enabled) out.reminders_enabled = after.reminders_enabled;
  if (before.timezone !== after.timezone) out.timezone = after.timezone;
  // days and preset travel together: the server checks them as a pair
  if (out.days || out.preset) {
    out.days = normalizeDays(after.days);
    out.preset = after.preset;
  }
  return out;
}

export const DEFAULT_SCHEDULE: Schedule = {
  preset: "daily",
  days: [...PRESET_DAYS.daily],
  preferred_time: "19:00",
  duration_min: 20,
  reminders_enabled: false,
  timezone: DEFAULT_TZ,
};
