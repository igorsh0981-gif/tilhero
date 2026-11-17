/**
 * Проверка Telegram Mini App initData на сервере (ТЗ «Telegram security», AT-18 «Tampered initData → 401»).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Основа — FinAdvisor services/app-bff/src/telegram-auth.ts, исправлено:
 *  - подпись сравнивается за постоянное время (crypto.timingSafeEqual), а не через `!==`;
 *  - `user` обязателен и проверяется здесь, а не в вызывающем коде;
 *  - auth_date из будущего (> 60 с) отклоняется; повторяющиеся ключи отклоняются;
 *  - причина отказа — машинный код (для логов/details), без содержимого initData.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ValidatedInitData {
  user: TelegramUser;
  authDate: number;
  startParam?: string;
  /** HMAC подписанных полей (hex, нижний регистр), посчитанный сервером по канонической data-check-string: не зависит
   *  от порядка параметров, кодирования (`%20` / `+`) и регистра `hash` в строке клиента — ключ одноразовости (О-1). */
  signature: string;
}

export type InitDataFailure =
  | "empty"
  | "too_long"
  | "malformed"
  | "duplicate_key"
  | "hash_missing"
  | "hash_mismatch"
  | "auth_date_missing"
  | "auth_date_invalid"
  | "auth_date_in_future"
  | "expired"
  | "user_missing"
  | "user_invalid";

export class InitDataError extends Error {
  constructor(
    public readonly reason: InitDataFailure,
    public readonly code: "INIT_DATA_INVALID" | "INIT_DATA_EXPIRED" = "INIT_DATA_INVALID",
  ) {
    super(`initData rejected: ${reason}`);
    this.name = "InitDataError";
  }
}

export interface ValidateOptions {
  maxAgeSeconds: number;
  /** Допуск расхождения часов для auth_date из будущего. */
  futureSkewSeconds?: number;
  /** Текущее время, unix-секунды (для тестов). */
  nowSeconds?: number;
}

/** Реальный initData — около 0.5–1 КБ; всё сильно длиннее не разбираем. */
export const INIT_DATA_MAX_LENGTH = 4096;

const HASH_RE = /^[0-9a-fA-F]{64}$/;

function secretKey(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken).digest();
}

function dataCheckString(entries: Array<[string, string]>): string {
  return entries
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function validateInitData(initData: string, botToken: string, opts: ValidateOptions): ValidatedInitData {
  if (!initData) throw new InitDataError("empty");
  if (initData.length > INIT_DATA_MAX_LENGTH) throw new InitDataError("too_long");
  if (!botToken) throw new Error("BOT_TOKEN is not configured");

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    throw new InitDataError("malformed");
  }

  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  let hash: string | undefined;
  for (const [key, value] of params) {
    if (seen.has(key)) throw new InitDataError("duplicate_key");
    seen.add(key);
    if (key === "hash") hash = value;
    else entries.push([key, value]);
  }
  if (!hash) throw new InitDataError("hash_missing");
  if (entries.length === 0) throw new InitDataError("malformed");

  // Подпись проверяем ДО разбора полей: неподписанный мусор всегда получает одинаковый ответ.
  const expected = createHmac("sha256", secretKey(botToken)).update(dataCheckString(entries)).digest();
  const received = HASH_RE.test(hash) ? Buffer.from(hash, "hex") : Buffer.alloc(expected.length);
  const hashOk = timingSafeEqual(expected, received) && HASH_RE.test(hash);
  if (!hashOk) throw new InitDataError("hash_mismatch");

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) throw new InitDataError("auth_date_missing");
  if (!/^\d{1,12}$/.test(authDateRaw)) throw new InitDataError("auth_date_invalid");
  const authDate = Number(authDateRaw);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (authDate - now > (opts.futureSkewSeconds ?? 60)) throw new InitDataError("auth_date_in_future");
  if (now - authDate > opts.maxAgeSeconds) throw new InitDataError("expired", "INIT_DATA_EXPIRED");

  const userRaw = params.get("user");
  if (!userRaw) throw new InitDataError("user_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(userRaw);
  } catch {
    throw new InitDataError("user_invalid");
  }
  const user = toTelegramUser(parsed);
  if (!user) throw new InitDataError("user_invalid");

  const startParam = params.get("start_param") ?? undefined;
  return { user, authDate, signature: expected.toString("hex"), ...(startParam ? { startParam } : {}) };
}

function optString(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

function toTelegramUser(v: unknown): TelegramUser | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isSafeInteger(o.id) || o.id <= 0) return null;
  const firstName = optString(o.first_name, 256);
  if (!firstName) return null;
  const user: TelegramUser = { id: o.id, first_name: firstName };
  const lastName = optString(o.last_name, 256);
  const username = optString(o.username, 64);
  const languageCode = optString(o.language_code, 16);
  if (lastName) user.last_name = lastName;
  if (username) user.username = username;
  if (languageCode) user.language_code = languageCode;
  return user;
}

// ---------------------------------------------------------------------------------------------
// Подпись initData — только для локальной разработки, e2e Mini App и тестов (scripts/dev-init-data.ts).

export interface SignInitDataOptions {
  user?: object | null;
  authDate?: number;
  queryId?: string;
  startParam?: string;
  extra?: Record<string, string>;
}

/** Строит initData, подписанный так же, как это делает Telegram (HMAC-SHA256, ключ «WebAppData»). */
export function signInitData(botToken: string, opts: SignInitDataOptions = {}): string {
  const fields: Array<[string, string]> = [];
  fields.push(["auth_date", String(opts.authDate ?? Math.floor(Date.now() / 1000))]);
  if (opts.queryId) fields.push(["query_id", opts.queryId]);
  if (opts.user) fields.push(["user", JSON.stringify(opts.user)]);
  if (opts.startParam) fields.push(["start_param", opts.startParam]);
  for (const [k, v] of Object.entries(opts.extra ?? {})) fields.push([k, v]);
  const hash = createHmac("sha256", secretKey(botToken)).update(dataCheckString(fields)).digest("hex");
  const params = new URLSearchParams(fields);
  params.append("hash", hash);
  return params.toString();
}
