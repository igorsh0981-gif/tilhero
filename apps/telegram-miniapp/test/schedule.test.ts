import type { Schedule } from "@tilhero/contracts/bff";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  choosePreset,
  isValidTime,
  isValidZone,
  normalizeDays,
  presetForDays,
  scheduleDiff,
  scheduleProblem,
  timeChoice,
  toggleDay,
  utcOffset,
  zoneOptions,
} from "../src/domain/schedule";

const s = (over: Partial<Schedule> = {}): Schedule => ({ ...DEFAULT_SCHEDULE, ...over });

describe("schedule (AT-06)", () => {
  it("presets give their days (bff.ts: daily 1..7, weekdays 1..5, three_per_week 1,3,5)", () => {
    expect(choosePreset(s(), "daily").days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(choosePreset(s(), "weekdays").days).toEqual([1, 2, 3, 4, 5]);
    expect(choosePreset(s(), "three_per_week").days).toEqual([1, 3, 5]);
  });
  it("«свои дни» keeps the current days", () => {
    expect(choosePreset(s({ preset: "weekdays", days: [1, 2, 3, 4, 5] }), "custom")).toEqual({ preset: "custom", days: [1, 2, 3, 4, 5] });
    expect(choosePreset(s({ days: [] }), "custom").days).toEqual([1, 3, 5]);
  });
  it("changing a day of a preset turns it into custom; matching days return the preset", () => {
    expect(toggleDay({ preset: "three_per_week", days: [1, 3, 5] }, 6)).toEqual({ preset: "custom", days: [1, 3, 5, 6] });
    expect(toggleDay({ preset: "weekdays", days: [1, 2, 3, 4, 5] }, 5)).toEqual({ preset: "custom", days: [1, 2, 3, 4] });
    expect(toggleDay({ preset: "custom", days: [1, 2, 3, 4] }, 5)).toEqual({ preset: "weekdays", days: [1, 2, 3, 4, 5] });
    expect(toggleDay({ preset: "custom", days: [1, 2, 3, 4, 5, 6] }, 7)).toEqual({ preset: "daily", days: [1, 2, 3, 4, 5, 6, 7] });
  });
  it("the last day cannot be removed (days: 1..7 entries)", () => {
    expect(toggleDay({ preset: "custom", days: [3] }, 3)).toEqual({ preset: "custom", days: [3] });
  });
  it("normalizes days: integers 1..7, ascending, unique", () => {
    expect(normalizeDays([5, 1, 5, 0, 8, 2.5, "3", 7])).toEqual([1, 5, 7]);
    expect(presetForDays([5, 3, 1])).toBe("three_per_week");
  });
  it("time HH:MM and the client presets 08:00 / 13:00 / 19:00", () => {
    expect(isValidTime("07:30")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:30")).toBe(false);
    expect(timeChoice("08:00")).toBe("morning");
    expect(timeChoice("13:00")).toBe("day");
    expect(timeChoice("19:00")).toBe("evening");
    expect(timeChoice("19:05")).toBe("custom");
  });
  it("validation names the first wrong field", () => {
    expect(scheduleProblem(s())).toBeNull();
    expect(scheduleProblem(s({ days: [] }))).toBe("days");
    expect(scheduleProblem(s({ preferred_time: "25:00" }))).toBe("preferred_time");
    expect(scheduleProblem(s({ duration_min: 25 as 20 }))).toBe("duration_min");
    expect(scheduleProblem(s({ timezone: "Mars/Base" }))).toBe("timezone");
  });
  it("diff for PATCH: only changed fields; days and preset travel together", () => {
    expect(scheduleDiff(s(), s())).toEqual({});
    expect(scheduleDiff(s(), s({ duration_min: 30 }))).toEqual({ duration_min: 30 });
    expect(scheduleDiff(s(), s({ preset: "weekdays", days: [1, 2, 3, 4, 5] }))).toEqual({ preset: "weekdays", days: [1, 2, 3, 4, 5] });
    expect(scheduleDiff(s({ preset: "custom", days: [1, 2] }), s({ preset: "custom", days: [1, 2, 3] }))).toEqual({ preset: "custom", days: [1, 2, 3] });
  });
  it("time zones: IANA check, the device zone first, offset label", () => {
    expect(isValidZone("Asia/Tashkent")).toBe(true);
    expect(isValidZone("Asia/Nowhere")).toBe(false);
    expect(isValidZone("../etc")).toBe(false);
    const opts = zoneOptions("Asia/Tashkent", "Europe/Berlin");
    expect(opts.slice(0, 2)).toEqual(["Asia/Tashkent", "Europe/Berlin"]);
    expect(new Set(opts).size).toBe(opts.length);
    expect(utcOffset("Asia/Tashkent")).toBe("UTC+5");
    expect(utcOffset("UTC")).toBe("UTC");
  });
});
