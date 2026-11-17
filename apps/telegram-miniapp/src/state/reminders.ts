import type { LearningPlan, NotificationCategories, Profile } from "@tilhero/contracts/bff";
import type { Bff } from "../api/bff";
import { requestWriteAccess } from "../tg";

/**
 * Reminders need two switches on the server: the plan's opt-in (learning-plan emits «время занятия» only when
 * schedule.reminders_enabled, APP-ONB-03) and the delivery category (notifications sends only enabled categories,
 * AT-13). They are always changed together. Turning reminders on also asks Telegram to let the bot write.
 */
export async function setLessonReminders(bff: Bff, on: boolean, plan: LearningPlan): Promise<{ plan: LearningPlan; profile: Profile }> {
  if (on) await requestWriteAccess();
  const nextPlan = plan.schedule.reminders_enabled === on ? plan : await bff.patchPlan({ schedule: { reminders_enabled: on } }, plan.version);
  const profile = await bff.patchSettings({ notifications: { ...(on ? { enabled: true } : {}), categories: { reminders: on } } });
  return { plan: nextPlan, profile };
}

/** Categories patch for the onboarding opt-ins (only what the user switched on; the master switch on when any). */
export function optInPatch(cats: Partial<NotificationCategories>, timezone: string): NonNullable<Parameters<Bff["patchSettings"]>[0]["notifications"]> {
  const any = Object.values(cats).some(Boolean);
  return { ...(any ? { enabled: true } : {}), categories: cats, timezone };
}
