/**
 * Публичный контракт сайта оплаты TilHero (спринт 8, INTERNAL_API §3): telegram-bff `/web/v1/*` ↔ `apps/web-pay`.
 * ЕДИНСТВЕННЫЙ источник типов для обеих сторон. Сайт работает вне Telegram (решение владельца В1): тарифы и пакеты
 * тилов за сумы через Payme, Click, Uzum. Из Mini App и бота на сайт нет ссылок (анти-стиринг); направление
 * «сайт → Telegram» разрешено («Аккаунт не найден — откройте TilHero в Telegram»).
 *
 * Транспорт: браузер ходит только на свой origin — Caddy web-pay проксирует `/api/<путь>` на telegram-bff
 * `/web/v1/<путь>` по приватной сети. Маршруты существуют только при WEB_PAY_ENABLED=true (иначе 404 NOT_FOUND).
 *
 * Вход — «Log In with Telegram» (OpenID Connect, Authorization Code + PKCE S256), перенаправлениями, без сторонних
 * скриптов; токен бота сайту не нужен:
 *  1. `GET /api/auth/start` → 302 на `https://oauth.telegram.org/auth?…` (state, code_challenge; cookie
 *     `__Host-wp_oidc` — HttpOnly, Secure, SameSite=Lax, 10 мин);
 *  2. `GET /api/auth/callback?code&state` → проверка state (одноразово), обмен code, проверка id_token по JWKS (iss,
 *     aud, exp) → аккаунт TilHero по Telegram ID → cookie `__Host-wp_session` (HttpOnly, Secure, SameSite=Strict,
 *     Path=/; 30 мин скользящая, ≤ 2 ч) → 302 на `/` (адрес очищен от code и state). Не удалось — 302 на
 *     `/?login_error=<WebLoginError>`. Аккаунт на сайте не создаётся; Telegram ID и id_token нигде не хранятся;
 *  3. `POST /api/auth/logout` → 204 (сессия отозвана, cookie удалены).
 * ПДн в URL нет: только одноразовые code/state и номер заказа; scope `openid` (имя, username, телефон не запрашиваются).
 *
 * Изменяющие запросы (POST) обязаны нести `X-CSRF-Token` = `WebMe.csrf_token` и `Origin` = origin сайта — иначе 403
 * CSRF_INVALID. Создание заказа — с `Idempotency-Key` (UUID).
 *
 * Деньги — целые тийины (1 сум = 100 тийинов, ADR-0001): сайт показывает «49 000 сум» / «49 000 soʻm» (U+02BB),
 * считая целочисленно. Цена заказа — только из каталога на сервере.
 *
 * Ошибки — ErrorBody: 401 SESSION_EXPIRED (нет или истекла сессия — войти заново); 403 CSRF_INVALID; 403
 * PAYER_REQUIRED | GUARDIAN_CONSENT_REQUIRED (14–17 без согласия родителя) | BENEFICIARY_NOT_ALLOWED; 409
 * PAYMENTS_DISABLED | PROVIDER_NOT_AVAILABLE; 422 PROVIDER_NOT_ALLOWED; 404 PRODUCT_NOT_FOUND | ORDER_NOT_FOUND; 409
 * PRODUCT_NOT_AVAILABLE | OFFER_VERSION_MISMATCH {current} | FORFEIT_CONFIRMATION_REQUIRED {minutes_left, days_left} |
 * ORDER_STATE {status}; 429 ORDERS_LIMIT | RATE_LIMITED {retry_after} (лимиты web.auth_ip, web.read, web.order);
 * 503 BILLING_UNAVAILABLE; 422 VALIDATION_ERROR; 500 INTERNAL_ERROR.
 */

import type {
  BillingFeature, BillingOrderStatus, BillingProductKind, ErrorBody, Page, SubscriptionView,
} from "./bff.js";
import type { Localized } from "./content.js";

export type { ErrorBody, Page };

/** Способы оплаты сайта (только они; Telegram Stars — только в Mini App). */
export type WebProvider = "payme" | "click" | "uzum";

/** Код неудачного входа в `?login_error=` после `/api/auth/callback`: auth_failed — подпись, срок, state или обмен
 *  кода не прошли; account_not_found — аккаунта TilHero нет («сначала откройте TilHero в Telegram»); not_allowed —
 *  вход недоступен (профиль удаляется). */
export type WebLoginError = "auth_failed" | "account_not_found" | "not_allowed";

/** GET /web/v1/me → WebMe (сессия; выдаёт CSRF-токен, привязанный к сессии). Нет сессии — 401 SESSION_EXPIRED. */
export interface WebMe {
  account: {
    age_band: "14-17" | "18+" | null;
    /** 18+ или 14–17 с согласием родителя */
    can_pay: boolean;
    /** 14–17 без согласия родителя: оплата недоступна, нужно согласие в Mini App */
    consent_required: boolean;
  };
  /** свои ученики — для выбора получателя пакета тилов: сам аккаунт и его детские профили 6–13 */
  learners: Array<{ learner_id: string; kind: "self" | "child"; display: string }>;
  csrf_token: string;
}

/** Цена сайта — только сумы в тийинах (кратна 100: целые сумы). */
export interface WebPrice {
  tiyin: number; // 100..10¹¹
}

/** Товар каталога для сайта: показывается только товар с ценой в сумах и включёнными способами оплаты. */
export interface WebProduct {
  code: string;
  kind: BillingProductKind;
  title: Localized;
  description: Localized | null;
  days: number | null;
  minutes: number | null;
  features: BillingFeature[];
  til: number | null;
  price: WebPrice;
}

/** GET /web/v1/catalog → WebCatalog (канал web). Пробного периода на сайте нет (только в Mini App). */
export interface WebCatalog {
  /** PAYMENTS_ENABLED и хотя бы один включённый способ оплаты */
  sales_enabled: boolean;
  providers: WebProvider[];
  /** оферта (общая для каналов, на домене Mini App) — согласие до оплаты, версия передаётся в заказ */
  offer: { version: string; url: string };
  products: WebProduct[];
  payer_required: boolean;
  can_pay: boolean;
  consent_required: boolean;
}

/** GET /web/v1/subscription → WebSubscriptionView: статус подписки аккаунта и минуты, без подписки Stars и пробного. */
export type WebSubscriptionView = Omit<SubscriptionView, "stars_subscription" | "trial_available">;

/** POST /web/v1/orders (Idempotency-Key, X-CSRF-Token, Origin) WebOrderRequest → WebOrder (201; тот же незавершённый
 *  заказ — 200). Подписка: start_mode обязателен — after_current (следующий период) или now (только с
 *  confirm_forfeit: true при активном периоде — остаток сгорает). Пакет тилов — себе или своему детскому профилю
 *  (beneficiary_id = WebMe.learners[].learner_id). Дальше — переход на checkout_url (location.assign); покупатель
 *  возвращается на `/orders/{order_no}` (страница заказа сайта: опрос статуса, фискальный чек). */
export interface WebOrderRequest {
  product_code: string;
  provider: WebProvider;
  start_mode?: "after_current" | "now";
  confirm_forfeit?: boolean;
  beneficiary_id?: string;
  offer_version: string;
}

/** Заказ сайта. GET /web/v1/orders?cursor= → Page<WebOrder> — только заказы сайта; GET /web/v1/orders/{order_no} →
 *  WebOrder (чужой или не сайта — 404 ORDER_NOT_FOUND); POST /web/v1/orders/{order_no}/cancel → WebOrder (только
 *  pending без живой транзакции; иначе 409 ORDER_STATE {status}). */
export interface WebOrder {
  order_no: number;
  status: BillingOrderStatus;
  product: { code: string; kind: BillingProductKind; title: Localized };
  currency: "UZS";
  amount_tiyin: number;
  provider: WebProvider;
  /** страница оплаты провайдера (https) — пока заказ pending; после оплаты — null */
  checkout_url: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
  /** фискальный чек продажи (https, QR ГНК) — когда зарегистрирован */
  receipt_url: string | null;
  refund: { status: "awaiting_provider" | "completed" | "failed"; receipt_url: string | null } | null;
}
