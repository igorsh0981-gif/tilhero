import type { PolicyDocument } from "@tilhero/contracts/bff";

/**
 * Purposes to accept: every required purpose of the current policy plus the optional ones the user
 * opted into — `notifications` follows the notifications toggle (onboarding step 6 / profile).
 */
export function consentPurposes(policy: Pick<PolicyDocument, "purposes"> | null, optIn: { notifications: boolean }): string[] {
  if (!policy) return [];
  return policy.purposes.filter((p) => p.required || (p.code === "notifications" && optIn.notifications)).map((p) => p.code);
}
