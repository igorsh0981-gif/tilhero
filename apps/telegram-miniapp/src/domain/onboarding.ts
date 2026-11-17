import type { AgeBand, ConsentState, GuardianConsent } from "@tilhero/contracts/bff";

/**
 * Onboarding without a long questionnaire (APP-ONB-01, AT-04): every step fits 390×844 without scrolling.
 * Order (sprint 1 task): interface language → who and age → [child profile | parent link for 14–17] → consents →
 * goal → level → schedule: days and time → duration, reminders, time zone → done.
 * The list of steps is fixed when onboarding starts (so «Шаг N из M» does not jump) and depends only on the choices
 * made in it; steps whose result is already stored on the server (age, child profile) cannot be revisited.
 */
export type ObStep = "lang" | "who" | "child" | "teen" | "consent" | "goal" | "level" | "when" | "minutes";
export type Who = "self" | "child";

export interface ObStart {
  /** the account had no age yet: the first launch */
  firstRun: boolean;
  /** consents were accepted for the current policy version before onboarding started */
  consentOk: boolean;
}

export interface ObChoices {
  who: Who | null;
  age: AgeBand | null;
}

export function obSteps(start: ObStart, ch: ObChoices): ObStep[] {
  const s: ObStep[] = [];
  if (start.firstRun) {
    s.push("lang", "who");
    if (ch.who === "child") s.push("child");
    else if (ch.who === "self" && ch.age === "14-17") s.push("teen");
  }
  if (start.firstRun || !start.consentOk) s.push("consent");
  s.push("goal", "level", "when", "minutes");
  return s;
}

export interface ObCommitted {
  /** PUT /v1/profile/age succeeded */
  ageSet: boolean;
  /** the child profile was created and is active */
  childCreated: boolean;
}

/** Steps that can no longer be changed in onboarding (age changes only through support). */
export function isLocked(step: ObStep, c: ObCommitted): boolean {
  if (step === "who") return c.ageSet;
  if (step === "child") return c.childCreated;
  if (step === "lang" || step === "consent") return c.childCreated;
  return false;
}

/** The step «Назад» leads to, or null. */
export function prevStep(steps: readonly ObStep[], cur: ObStep, c: ObCommitted): ObStep | null {
  const i = steps.indexOf(cur);
  if (i <= 0) return null;
  const p = steps[i - 1]!;
  return isLocked(p, c) ? null : p;
}

export function nextStep(steps: readonly ObStep[], cur: ObStep): ObStep | "done" {
  const i = steps.indexOf(cur);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1]! : "done";
}

export function consentIsCurrent(c: Pick<ConsentState, "accepted" | "policy_version" | "current_policy_version">): boolean {
  return c.accepted && !!c.policy_version && c.policy_version === c.current_policy_version;
}

/** Ages offered on the «who» step: self — 14–17 / 18+ (younger children only through a parent), child — 6–9 / 10–13. */
export function agesFor(who: Who | null): AgeBand[] {
  if (who === "self") return ["14-17", "18+"];
  if (who === "child") return ["6-9", "10-13"];
  return [];
}

/** Optional purposes are unavailable to a teen until the parent consents (403 GUARDIAN_CONSENT_REQUIRED). */
export function optionalAllowed(age: AgeBand | null, guardian: GuardianConsent): boolean {
  return age !== "14-17" || guardian === "granted";
}

/** First step to fix after 409 PLAN_INCOMPLETE {missing}. */
export function stepForMissing(missing: unknown): ObStep {
  const m = Array.isArray(missing) ? missing.map(String) : [];
  if (m.includes("goal")) return "goal";
  if (m.includes("level_self")) return "level";
  if (m.some((x) => x.startsWith("schedule") || x === "days" || x === "preferred_time")) return "when";
  return "goal";
}
