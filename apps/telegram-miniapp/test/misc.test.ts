import { describe, expect, it } from "vitest";
import { bootErrorPhase } from "../src/App";
import { ApiError } from "../src/api/errors";
import { ageSegment, invitePermissions, teenWithoutConsent } from "../src/domain/people";
import { confirmWord, wordMatches } from "../src/screens/profile/DeleteScreen";
import { greetingKey, isoWeekday } from "../src/screens/home/Home";
import { routeTarget } from "../src/state/nav";
import { keyForDraft } from "../src/state/idempotency";

const acc = (age: "14-17" | "18+" | null, gc: "pending" | "granted" | "not_required" = "not_required") =>
  ({ account: { age_band: age, guardian_consent: gc }, learner: { kind: "self" } }) as never;

describe("navigation by route (release notes, notifications, deep links)", () => {
  it("tabs reset the stack; screens are pushed on top so «Назад» returns", () => {
    expect(routeTarget("profile", { tab: "home", stack: [{ name: "inbox" }] })).toEqual({ tab: "profile", stack: [] });
    expect(routeTarget("family", { tab: "home", stack: [{ name: "inbox" }] })).toEqual({ tab: "home", stack: [{ name: "inbox" }, { name: "family" }] });
    expect(routeTarget("notifications", { tab: "home", stack: [{ name: "inbox" }] })).toEqual({ tab: "home", stack: [{ name: "inbox" }] });
    expect(routeTarget("schedule", { tab: "profile", stack: [{ name: "schedule" }, { name: "news" }] })).toEqual({ tab: "profile", stack: [{ name: "news" }, { name: "schedule" }] });
  });
});

describe("ages and permissions (CONVENTIONS §8)", () => {
  it("age segments for «Что нового»", () => {
    expect(ageSegment("6-9")).toBe("kids");
    expect(ageSegment("10-13")).toBe("kids");
    expect(ageSegment("14-17")).toBe("teens");
    expect(ageSegment(null)).toBe("adults");
  });
  it("family invites — adults; a teen invites friends after the parent's consent; a child — nothing", () => {
    expect(invitePermissions(acc("18+"))).toEqual({ family: true, friend: true, children: true });
    expect(invitePermissions(acc("14-17", "pending"))).toEqual({ family: false, friend: false, children: false });
    expect(invitePermissions(acc("14-17", "granted"))).toEqual({ family: false, friend: true, children: false });
    expect(invitePermissions({ account: { age_band: "18+" }, learner: { kind: "child" } } as never)).toEqual({ family: false, friend: false, children: false });
    expect(teenWithoutConsent(acc("14-17", "pending"))).toBe(true);
  });
});

describe("misc", () => {
  it("deletion word: case, spaces and the Uzbek apostrophe variants", () => {
    expect(confirmWord("uz")).toBe("OʻCHIRISH");
    expect(wordMatches(" удалить ", "УДАЛИТЬ")).toBe(true);
    expect(wordMatches("o'chirish", "OʻCHIRISH")).toBe(true);
    expect(wordMatches("удали", "УДАЛИТЬ")).toBe(false);
  });
  it("ISO weekday of a plan date and the greeting by hour", () => {
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-22")).toBe(7);
    expect(greetingKey(8)).toBe("home.hello.morning");
    expect(greetingKey(14)).toBe("home.hello.day");
    expect(greetingKey(20)).toBe("home.hello.evening");
    expect(greetingKey(2)).toBe("home.hello.night");
  });
  it("boot errors: reopen for bad initData, a notice for a deleted user, retry for the network", () => {
    expect(bootErrorPhase(new ApiError(401, "INIT_DATA_EXPIRED", ""))).toEqual({ kind: "error", err: "reopen", code: "INIT_DATA_EXPIRED" });
    expect(bootErrorPhase(new ApiError(410, "USER_DELETED", ""))).toMatchObject({ err: "deleted" });
    expect(bootErrorPhase(new ApiError(0, "NETWORK", ""))).toMatchObject({ err: "network", code: "NETWORK" });
    expect(bootErrorPhase(new ApiError(503, "UPSTREAM_UNAVAILABLE", ""))).toMatchObject({ err: "network", code: "SERVICE_UNAVAILABLE" });
  });
  it("Idempotency-Key: same draft → same key, any edit → a new key", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const a = keyForDraft(null, { s: "x" }, make);
    expect(keyForDraft(a, { s: "x" }, make).key).toBe("k1");
    expect(keyForDraft(a, { s: "y" }, make).key).toBe("k2");
  });
});
