import type { AgeBand, LearnerSummary, SessionResponse } from "@tilhero/contracts/bff";

/** Age rules (CONVENTIONS §8, AT-03): 6–13 — a child profile on the parent's account; 14–17 — own account with the
 *  parent's consent by link; 18+ — on their own. */
export type AgeSegment = "kids" | "teens" | "adults";

export function ageSegment(band: AgeBand | null | undefined): AgeSegment {
  if (band === "6-9" || band === "10-13") return "kids";
  if (band === "14-17") return "teens";
  return "adults";
}

export function isChildBand(band: AgeBand | null | undefined): boolean {
  return band === "6-9" || band === "10-13";
}

/** The active learner is a child profile (6–13) of this account. */
export function activeIsChild(s: Pick<SessionResponse, "learner">): boolean {
  return s.learner.kind === "child";
}

export function selfLearner(s: Pick<SessionResponse, "learners" | "account">): LearnerSummary | null {
  return s.learners.find((l) => l.kind === "self") ?? null;
}

export function children(s: Pick<SessionResponse, "learners">): LearnerSummary[] {
  return s.learners.filter((l) => l.kind === "child");
}

/** Teen whose parent has not confirmed yet: optional features (voice, social) stay off. */
export function teenWithoutConsent(s: Pick<SessionResponse, "account">): boolean {
  return s.account.age_band === "14-17" && s.account.guardian_consent !== "granted";
}

/** What the account may create from the family screen (the server checks again). */
export function invitePermissions(s: Pick<SessionResponse, "account" | "learner">): { family: boolean; friend: boolean; children: boolean } {
  if (activeIsChild(s)) return { family: false, friend: false, children: false };
  const adult = s.account.age_band === "18+";
  const teenOk = s.account.age_band === "14-17" && s.account.guardian_consent === "granted";
  return { family: adult, friend: adult || teenOk, children: adult };
}

export function initialOf(name: string): string {
  const ch = [...name.trim()][0];
  return ch ? ch.toUpperCase() : "?";
}
