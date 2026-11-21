/**
 * Спринт 7 — вызов social и lessons от имени активного ученика (INTERNAL_API спринта 7 §0, §9).
 *
 * Внутренний JWT — как у gamification и memory: `sub` = аккаунт, claims `lrn` (активный ученик: социальное «я» в
 * детском профиле — ребёнок) и `age_band` полосы АКТИВНОГО ученика (детский профиль — полоса ребёнка из
 * identity-consent; аудитории kids / teens / adults домены выводят по ней). `member_id` другого ученика BFF передаёт как
 * есть (не расшифровывает), `user_id` в запросах нет — только токен.
 *
 * Детский профиль (`lrn ≠ sub`) — всегда 6–13: действия, которых у детей нет по контракту, BFF отклоняет до вызова
 * домена (защита в глубину, как INVITES_NOT_ALLOWED спринта 1 и свободный текст урока спринта 4); прочее решает домен
 * по `age_band`.
 */
import type { AgeBand } from "@tilhero/contracts/bff";
import { AppError } from "@tilhero/ts-common";
import { asAccount } from "./account.js";
import type { BffContext } from "./context.js";
import type { AccessClaims } from "./tokens.js";
import type { RawRequest } from "./upstream.js";

export const KID_BANDS: ReadonlySet<AgeBand> = new Set(["6-9", "10-13"]);

export interface LearnerCall {
  /** детский профиль (lrn ≠ sub) */
  childProfile: boolean;
  /** 6–13: детский профиль или детская полоса аккаунта */
  kids: boolean;
  band: AgeBand | null;
  ro: RawRequest;
}

/** Параметры вызова домена от имени активного ученика: sub = аккаунт, claims lrn и age_band активного ученика. */
export async function learnerCall(ctx: BffContext, auth: AccessClaims): Promise<LearnerCall> {
  const band = await ctx.audience.learnerBand(ctx, auth);
  const childProfile = auth.learnerId !== auth.accountId;
  return {
    childProfile,
    kids: childProfile || (band !== null && KID_BANDS.has(band)),
    band,
    ro: { subject: asAccount(auth), claims: { lrn: auth.learnerId, ...(band ? { age_band: band } : {}) } },
  };
}

export const isChildProfile = (auth: AccessClaims): boolean => auth.learnerId !== auth.accountId;

/** Друзья и заявки детям недоступны (bff.ts FriendsUnavailableReason kids). */
export const friendsNotAllowedForKids = () =>
  new AppError(403, "FRIENDS_NOT_ALLOWED", "В детском профиле друзей нет — дуэли и парные уроки только с семьёй", { reason: "kids" });
/** Социальное недоступно (профиль сообщества social: friends_unavailable_reason) → код контракта: kids и
 *  guardian_consent — 403 FRIENDS_NOT_ALLOWED {reason}; consent — 403 CONSENT_REQUIRED {purpose: social}. */
export function socialUnavailable(reason: "kids" | "guardian_consent" | "consent"): AppError {
  if (reason === "consent") return new AppError(403, "CONSENT_REQUIRED", "Нужно согласие на социальные функции", { purpose: "social" });
  return reason === "kids"
    ? friendsNotAllowedForKids()
    : new AppError(403, "FRIENDS_NOT_ALLOWED", "Социальные функции — после согласия родителя", { reason: "guardian_consent" });
}

/** Блокировки, жалобы, рефералы, свободный текст и голос в парной комнате — не для детского профиля. */
export const kidsNotAllowed = (message = "В детском профиле это действие недоступно") => new AppError(403, "KIDS_NOT_ALLOWED", message);

/** 422 VALIDATION_ERROR о поле, которое схема проверить не может (связь полей, время, текст после обрезки). */
export const validationError = (field: string, rule: string, where: "body" | "querystring" = "body") =>
  new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", { in: where, field, errors: [{ field, rule, message: rule, params: {} }] });

/** Статус создающей команды: домен отвечает 201 (создано) или 200 (повтор, встречная заявка, тот же результат). */
export const createdStatus = (status: number): 200 | 201 => (status === 200 ? 200 : 201);
