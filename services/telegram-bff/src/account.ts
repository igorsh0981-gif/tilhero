/**
 * Аккаунт и ученики (CONVENTIONS §8, INTERNAL_API §9).
 *
 * В сессии два субъекта: sub — аккаунт Telegram, lrn — активный ученик (сам аккаунт или его детский профиль 6–13).
 * Для каждого вызова домена BFF выпускает внутренний JWT:
 *  - learning-plan, notifications (центр уведомлений), experience-config (for-me / seen / feed) — sub = lrn;
 *  - identity-consent /me/*, social, support — sub = аккаунт.
 * Список учеников и возраст — из identity-consent, признак завершённого онбординга — из плана каждого ученика
 * (learning-plan, identity его не знает).
 */
import type { AgeBand, LearningPlan, NotificationSettings, SessionResponse } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "./context.js";
import type { AccessClaims } from "./tokens.js";
import {
  learnerView,
  sessionView,
  type IdentityLearner,
  type IdentityMe,
  type LearnersState,
  type TelegramLoginResponse,
} from "./views.js";

export const learnerNotFound = () => new AppError(404, "LEARNER_NOT_FOUND", "Профиль ученика не найден");

/** sub внутреннего JWT к аккаунтным доменам (identity-consent /me/*, social, support). */
export const asAccount = (a: AccessClaims): string => a.accountId;
/** sub внутреннего JWT к учебным доменам (learning-plan, центр уведомлений, «Что нового»). */
export const asLearner = (a: AccessClaims): string => a.learnerId;

export function loadMe(ctx: BffContext, accountId: string): Promise<IdentityMe> {
  return ctx.domains.identity.get<IdentityMe>("/internal/v1/me", { subject: accountId });
}

export function loadPlan(ctx: BffContext, learnerId: string): Promise<LearningPlan> {
  return ctx.domains.learningPlan.get<LearningPlan>("/internal/v1/me/plan", { subject: learnerId });
}

/** Свой или свой ребёнок (identity-consent проверяет опекунство по sub = аккаунт); иначе 404 LEARNER_NOT_FOUND. */
export function loadLearner(ctx: BffContext, accountId: string, learnerId: string): Promise<IdentityLearner> {
  return ctx.domains.identity.get<IdentityLearner>(`/internal/v1/me/learners/${learnerId}`, { subject: accountId });
}

/** Ученики аккаунта: сам аккаунт всегда первый (если identity его не прислал — из UserSummary), затем дети. */
export function learnersOf(account: TelegramLoginResponse): IdentityLearner[] {
  const list = Array.isArray(account.learners) ? account.learners.filter((l) => l && typeof l.learner_id === "string") : [];
  const selfId = account.user.user_id;
  const self: IdentityLearner = list.find((l) => l.learner_id === selfId) ?? {
    learner_id: selfId,
    kind: "self",
    display_name: account.user.display_name,
    age_band: account.user.age_band ?? null,
    is_active: false,
    onboarding_completed: false,
  };
  return [{ ...self, kind: "self" }, ...list.filter((l) => l.learner_id !== selfId)];
}

/**
 * Ученики с признаком онбординга (план каждого — параллельно; сбой learning-plan → 503, частичного ответа нет)
 * и активный ученик. Активного нет среди учеников аккаунта → 404 LEARNER_NOT_FOUND.
 */
export async function learnersState(
  ctx: BffContext,
  list: IdentityLearner[],
  activeId: string,
): Promise<LearnersState & { activePlan: LearningPlan }> {
  const activeIdx = list.findIndex((l) => l.learner_id === activeId);
  if (activeIdx < 0) throw learnerNotFound();
  const plans = await Promise.all(list.map((l) => loadPlan(ctx, l.learner_id)));
  const learners = list.map((l, i) => learnerView(l, activeId, plans[i]?.onboarding_completed_at != null));
  return { learners, active: learners[activeIdx]!, activePlan: plans[activeIdx]! };
}

/** Есть ли ученик среди учеников аккаунта (детский профиль мог быть удалён). */
export function hasLearner(account: TelegramLoginResponse, learnerId: string): boolean {
  return learnersOf(account).some((l) => l.learner_id === learnerId);
}

/** Возраст активного ученика: аккаунт — из UserSummary, детский профиль — из списка учеников. */
export function learnerAgeBand(me: TelegramLoginResponse, learnerId: string): AgeBand | null {
  if (learnerId === me.user.user_id) return me.user.age_band ?? null;
  return learnersOf(me).find((l) => l.learner_id === learnerId)?.age_band ?? null;
}

/** Сегмент возраста «Что нового»: 6-9, 10-13 → kids; 14-17 → teens; 18+ и возраст не выбран → adults. */
export function ageSegment(band: AgeBand | null): "kids" | "teens" | "adults" {
  if (band === "6-9" || band === "10-13") return "kids";
  if (band === "14-17") return "teens";
  return "adults";
}

/** Настройки уведомлений активного ученика: аккаунт — из /me; детский профиль — из identity (если отдаёт), иначе
 *  настройки аккаунта (identity-consent пока не отдаёт настройки ребёнка — запрос к общему коду, README). */
export function notificationsFor(me: IdentityMe, learnerId: string, child?: IdentityLearner | null): NotificationSettings {
  if (learnerId === me.user.user_id) return me.settings;
  return child?.settings ?? learnersOf(me).find((l) => l.learner_id === learnerId)?.settings ?? me.settings;
}

/** SessionResponse: новые access-токен (sub, lrn, sid, pin) + профиль аккаунта + ученики. */
export async function buildSession(
  ctx: BffContext,
  s: { accountId: string; learnerId: string; sid: string; refreshToken: string; pinOk: boolean },
  account: TelegramLoginResponse,
  startParam: string | null = null,
): Promise<SessionResponse> {
  const ls = await learnersState(ctx, learnersOf(account), s.learnerId);
  const accessToken = await ctx.tokens.issue({ accountId: s.accountId, learnerId: s.learnerId, sid: s.sid, pin: s.pinOk });
  return sessionView({ accessToken, refreshToken: s.refreshToken, expiresIn: ctx.tokens.ttlSeconds }, account, ls, s.pinOk, startParam);
}
