/**
 * Ответы доменов и сборка публичных представлений BFF.
 * Поля копируются явно (whitelist), чтобы внутренние поля доменов (telegram_user_id и т. п.) не утекали
 * в Mini App, — урок FinAdvisor telegramProxy (S1): ничего не «спредим» вслепую.
 */
import type {
  ConsentState,
  NotificationSettings,
  Preferences,
  Profile,
  SecurityState,
  SessionResponse,
  UserSummary,
} from "@tilhero/contracts/bff";

/** identity-consent GET /internal/v1/me (и ответы PATCH settings, disable/enable). */
export interface IdentityMe {
  user: UserSummary;
  security: SecurityState;
  consent: ConsentState;
  settings: NotificationSettings;
}

/** identity-consent POST /internal/v1/users/telegram-login. */
export interface TelegramLoginResponse extends IdentityMe {
  onboarding_completed?: boolean | null;
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
  };
}

/**
 * pin_required — свойство СЕССИИ, а не пользователя: true, если PIN задан, а эта сессия его ещё не подтвердила.
 */
export function securityView(s: SecurityState, sessionPinOk: boolean): SecurityState {
  return {
    pin_enabled: s.pin_enabled,
    pin_length: s.pin_length ?? null,
    biometric_enabled: s.biometric_enabled,
    pin_required: s.pin_enabled && !sessionPinOk,
    locked_until: s.locked_until ?? null,
  };
}

export function consentView(c: ConsentState): ConsentState {
  return {
    accepted: c.accepted,
    policy_version: c.policy_version ?? null,
    current_policy_version: c.current_policy_version,
    accepted_at: c.accepted_at ?? null,
    evidence_hash: c.evidence_hash ?? null,
    age_confirmed_18_plus: c.age_confirmed_18_plus,
  };
}

export function settingsView(s: NotificationSettings): NotificationSettings {
  return {
    enabled: s.enabled,
    quiet_hours: s.quiet_hours ? { start: s.quiet_hours.start, end: s.quiet_hours.end } : null,
    digest_time: s.digest_time,
    timezone: s.timezone,
  };
}

/** Профиль: в авторизованном (прошедшем гейт PIN) запросе сессия всегда подтверждена. */
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** 6.3: preferences до миграции 0002 (выкладка) не присылает hotel_prefs — значения по умолчанию (null), а не 500 при
 *  сериализации ответа по схеме. */
export function preferencesView(p: Preferences): Preferences {
  const h = (p as { hotel_prefs?: unknown }).hotel_prefs;
  const o = h !== null && typeof h === "object" ? (h as Record<string, unknown>) : {};
  const int = (v: unknown, lo: number, hi: number) => { const n = num(v, lo, hi); return n !== null && Number.isInteger(n) ? n : null; };
  return { ...p, hotel_prefs: { rating_min: num(o.rating_min, 0, 10), max_distance_km: int(o.max_distance_km, 1, 20), min_stars: int(o.min_stars, 0, 5) } };
}

export function profileView(me: IdentityMe, prefs: Preferences): Profile {
  return {
    user: userView(me.user),
    security: securityView(me.security, true),
    consent: consentView(me.consent),
    preferences: preferencesView(prefs),
    notifications: settingsView(me.settings),
  };
}

export function sessionView(
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  me: IdentityMe,
  prefs: Preferences,
  sessionPinOk: boolean,
): SessionResponse {
  return {
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    user: userView(me.user),
    security: securityView(me.security, sessionPinOk),
    consent: consentView(me.consent),
    onboarding_completed: prefs.onboarding_completed_at != null,
  };
}
