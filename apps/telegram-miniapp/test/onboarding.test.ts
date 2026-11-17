import { describe, expect, it } from "vitest";
import { agesFor, consentIsCurrent, isLocked, nextStep, obSteps, optionalAllowed, prevStep, stepForMissing } from "../src/domain/onboarding";

describe("onboarding steps (AT-03, AT-04)", () => {
  const first = { firstRun: true, consentOk: false };
  it("adult: language → who → consents → goal → level → when → minutes", () => {
    expect(obSteps(first, { who: "self", age: "18+" })).toEqual(["lang", "who", "consent", "goal", "level", "when", "minutes"]);
  });
  it("teen 14–17 gets the parent link step; a child — the child profile step", () => {
    expect(obSteps(first, { who: "self", age: "14-17" })).toContain("teen");
    const child = obSteps(first, { who: "child", age: "6-9" });
    expect(child.slice(0, 4)).toEqual(["lang", "who", "child", "consent"]);
    expect(child).not.toContain("teen");
  });
  it("a returning learner or a new child profile: only the plan (and consents when outdated)", () => {
    expect(obSteps({ firstRun: false, consentOk: true }, { who: null, age: null })).toEqual(["goal", "level", "when", "minutes"]);
    expect(obSteps({ firstRun: false, consentOk: false }, { who: null, age: null })[0]).toBe("consent");
  });
  it("6–13 never chooses themselves: self offers 14–17 / 18+, a child 6–9 / 10–13", () => {
    expect(agesFor("self")).toEqual(["14-17", "18+"]);
    expect(agesFor("child")).toEqual(["6-9", "10-13"]);
    expect(agesFor(null)).toEqual([]);
  });
  it("steps stored on the server are not revisited", () => {
    const steps = obSteps(first, { who: "self", age: "18+" });
    expect(prevStep(steps, "consent", { ageSet: true, childCreated: false })).toBeNull();
    expect(prevStep(steps, "who", { ageSet: false, childCreated: false })).toBe("lang");
    expect(prevStep(steps, "goal", { ageSet: true, childCreated: false })).toBe("consent");
    expect(prevStep(steps, "goal", { ageSet: true, childCreated: true })).toBeNull();
    expect(isLocked("level", { ageSet: true, childCreated: true })).toBe(false);
    expect(nextStep(steps, "minutes")).toBe("done");
    expect(nextStep(steps, "lang")).toBe("who");
  });
  it("optional purposes wait for the parent of a teen", () => {
    expect(optionalAllowed("14-17", "pending")).toBe(false);
    expect(optionalAllowed("14-17", "granted")).toBe(true);
    expect(optionalAllowed("18+", "not_required")).toBe(true);
  });
  it("consents are current only for the current policy version", () => {
    expect(consentIsCurrent({ accepted: true, policy_version: "1.2", current_policy_version: "1.2" })).toBe(true);
    expect(consentIsCurrent({ accepted: true, policy_version: "1.1", current_policy_version: "1.2" })).toBe(false);
    expect(consentIsCurrent({ accepted: false, policy_version: null, current_policy_version: "1.2" })).toBe(false);
  });
  it("409 PLAN_INCOMPLETE {missing} → the step to fix", () => {
    expect(stepForMissing(["level_self"])).toBe("level");
    expect(stepForMissing(["schedule.days"])).toBe("when");
    expect(stepForMissing(["goal", "level_self"])).toBe("goal");
    expect(stepForMissing(undefined)).toBe("goal");
  });
});
