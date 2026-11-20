/**
 * Ответы доменов и сборка публичных представлений BFF.
 * Поля копируются явно (whitelist), чтобы внутренние поля доменов (telegram_user_id и т. п.) не утекали
 * в Mini App: ничего не «спредим» вслепую. Значения перечислений, которых нет в контракте, приводятся к безопасным
 * (сериализатор по схеме иначе ответил бы 500).
 */
import type {
  ConsentState,
  Family,
  GuardianConsentGrant,
  InboxItem,
  LearnerSummary,
  NotificationCategories,
  NotificationSettings,
  Profile,
  SecurityState,
  SessionResponse,
  UserSummary,
  WhatsNewNote,
} from "@tilhero/contracts/bff";
import { ILLUSTRATION_RE, INBOX_TELEGRAM, NOTE_ICONS, NOTE_ROUTES, NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_KEYS } from "./schemas.js";

/** identity-consent: LearnerSummary; settings — настройки уведомлений детского профиля, если identity их отдаёт
 *  (GET/PATCH /internal/v1/me/learners/{id}; запрос к identity-consent, см. README). */
export interface IdentityLearner extends LearnerSummary {
  settings?: NotificationSettings | null;
}

/** identity-consent POST /internal/v1/users/telegram-login → LoginResponse. */
export interface TelegramLoginResponse {
  user: UserSummary;
  security: SecurityState;
  consent: ConsentState;
  learners: IdentityLearner[];
}

/** identity-consent GET /internal/v1/me (и ответы PATCH settings, PUT age) → MeResponse. */
export interface IdentityMe extends TelegramLoginResponse {
  settings: NotificationSettings;
}

export interface TelegramLoginRequest {
  telegram_user_id: number;
  first_name: string;
  username?: string;
  last_name?: string;
  language_code?: string;
}

export function userView(u: UserSummary): UserSummary {
  return {
    user_id: u.user_id,
    display_name: u.display_name,
    username: u.username ?? null,
    locale: u.locale,
    status: u.status,
    is_new: u.is_new ?? false,
    age_band: u.age_band ?? null,
    guardian_consent: u.guardian_consent ?? "not_required",
  };
}

/** pin_required — свойство СЕССИИ: true, если код родителя задан, а эта сессия его ещё не подтвердила. */
export function securityView(s: SecurityState, sessionPinOk: boolean): SecurityState {
  return {
    pin_enabled: s.pin_enabled,
    pin_length: s.pin_length ?? null,
    biometric_enabled: s.biometric_enabled,
    pin_required: s.pin_enabled && !sessionPinOk,
    locked_until: s.locked_until ?? null,
    pin_reset_effective_at: s.pin_reset_effective_at ?? null,
  };
}

export function consentView(c: ConsentState): ConsentState {
  return {
    accepted: c.accepted,
    policy_version: c.policy_version ?? null,
    current_policy_version: c.current_policy_version,
    accepted_at: c.accepted_at ?? null,
    evidence_hash: c.evidence_hash ?? null,
    purposes: Array.isArray(c.purposes) ? c.purposes.filter((p): p is string => typeof p === "string") : [],
  };
}

export function settingsView(s: NotificationSettings): NotificationSettings {
  const src = (s.categories ?? {}) as Partial<NotificationCategories>;
  const categories = Object.fromEntries(NOTIFICATION_CATEGORY_KEYS.map((k) => [k, src[k] === true])) as unknown as NotificationCategories;
  return {
    enabled: s.enabled,
    categories,
    quiet_hours: s.quiet_hours ? { start: s.quiet_hours.start, end: s.quiet_hours.end } : null,
    timezone: s.timezone,
  };
}

/** Ученик для Mini App: is_active — по lrn сессии, onboarding_completed — из learning-plan (identity его не знает),
 *  voice_consent — из identity-consent как есть (спринт 5). */
export function learnerView(l: LearnerSummary, activeId: string, onboarded: boolean): LearnerSummary {
  return {
    learner_id: l.learner_id,
    kind: l.kind === "child" ? "child" : "self",
    display_name: l.display_name,
    age_band: l.age_band ?? null,
    is_active: l.learner_id === activeId,
    onboarding_completed: onboarded,
    // спринт 5: решение identity-consent (своё согласие / согласие опекуна); нет поля — запись голоса не разрешена
    voice_consent: l.voice_consent === true,
  };
}

export interface LearnersState {
  learners: LearnerSummary[];
  active: LearnerSummary;
}

export function sessionView(
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  account: { user: UserSummary; security: SecurityState; consent: ConsentState },
  ls: LearnersState,
  sessionPinOk: boolean,
  startParam: string | null,
): SessionResponse {
  return {
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    account: userView(account.user),
    learner: ls.active,
    learners: ls.learners,
    security: securityView(account.security, sessionPinOk),
    consent: consentView(account.consent),
    onboarding_completed: ls.active.onboarding_completed,
    start_param: startParam,
  };
}

/** Профиль: в авторизованном (прошедшем гейт кода родителя) запросе сессия всегда подтверждена. */
export function profileView(me: IdentityMe, ls: LearnersState, notifications: NotificationSettings): Profile {
  return {
    account: userView(me.user),
    learner: ls.active,
    learners: ls.learners,
    security: securityView(me.security, true),
    consent: consentView(me.consent),
    notifications: settingsView(notifications),
  };
}

/** start_param Telegram: [A-Za-z0-9_-]{1,64} (inv_…, invite_…, gc_…, ticket_…, route_…); иное — null. */
export const START_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const startParamView = (v: string | undefined | null): string | null => (v && START_PARAM_RE.test(v) ? v : null);

/** Запись центра уведомлений: telegram_status домена `skipped` и прочие вне контракта → in_app_only (сообщение есть
 *  только в приложении); неизвестная категория → service; startapp — только формат start_param. */
export function inboxItemView(i: InboxItem): InboxItem {
  const telegram = (INBOX_TELEGRAM as readonly string[]).includes(i.telegram) ? i.telegram : "in_app_only";
  const category = (NOTIFICATION_CATEGORIES as readonly string[]).includes(i.category) ? i.category : "service";
  return {
    notification_id: i.notification_id,
    category,
    title: i.title,
    body: i.body,
    startapp: startParamView(i.startapp),
    created_at: i.created_at,
    read_at: i.read_at ?? null,
    telegram,
  };
}

/** Заметка «Что нового»: маршрут/иконка не из каталога release-notes.json → null (пункт без ссылки/иконки);
 *  ключ иллюстрации не того формата (или его нет — домен до 6.1) → null (заметка без картинки). */
export function noteView(n: WhatsNewNote): WhatsNewNote {
  return {
    release_note_id: n.release_note_id,
    slug: n.slug,
    title: n.title,
    items: (Array.isArray(n.items) ? n.items : []).map((i) => ({
      title: i.title,
      text: i.text,
      link: i.link && (NOTE_ROUTES as readonly string[]).includes(i.link) ? i.link : null,
      icon: i.icon && (NOTE_ICONS as readonly string[]).includes(i.icon) ? i.icon : null,
    })),
    audience: n.audience,
    illustration: typeof n.illustration === "string" && ILLUSTRATION_RE.test(n.illustration) ? n.illustration : null,
    published_at: n.published_at,
  };
}

/** Семья: social знает только аккаунт (sub), «я» — активный ученик (в детском профиле — ребёнок). */
export function familyView(f: Family, learnerId: string): Family {
  return {
    family_id: f.family_id,
    members: (Array.isArray(f.members) ? f.members : []).map((m) => ({
      user_id: m.user_id,
      display_name: m.display_name,
      role: m.role,
      is_me: m.user_id === learnerId,
    })),
  };
}

/** Решение родителя по подростку (identity-consent /me/guardian-consents): только поля контракта; статус вне контракта
 *  (`revoked` — согласие отозвано, у подростка guardian_consent=declined) → declined; запись без id/даты или с
 *  неизвестным статусом — null (не показывается). */
export function guardianGrantView(g: unknown): GuardianConsentGrant | null {
  if (!g || typeof g !== "object") return null;
  const x = g as Record<string, unknown>;
  if (typeof x.teen_user_id !== "string" || typeof x.decided_at !== "string") return null;
  const status = x.status === "granted" ? "granted" : x.status === "declined" || x.status === "revoked" ? "declined" : null;
  if (!status) return null;
  return {
    teen_user_id: x.teen_user_id,
    teen_display_name: typeof x.teen_display_name === "string" ? x.teen_display_name : "",
    status,
    decided_at: x.decided_at,
  };
}
