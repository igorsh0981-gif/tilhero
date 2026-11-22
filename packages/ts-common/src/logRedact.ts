/**
 * Фильтр секретов в логах Node-сервисов — пара к py-common `tilhero_common.logging` (спринт 8, INTERNAL_API §0.8).
 *
 * buildBase применяет его к каждому объекту лога (pino `formatters.log`) раньше собственного `logFormatter` сервиса:
 * значение поля с именем из SECRET_LOG_KEYS в любом месте объекта становится "[redacted]". Имя сравнивается целиком
 * после нормализации (camelCase / kebab-case → snake_case, без учёта регистра):
 *  - `key` и `code` — только точные имена: `idempotency_key`, `dedup_key`, `upstream_code`, `err_code` не трогаются;
 *  - `code` с бизнес-кодом ошибки (UPPER_SNAKE: `PAYMENTS_DISABLED`, `PIN_INVALID`) остаётся виден — его пишет
 *    обработчик ошибок; одноразовый код OIDC, TOTP и т. п. на него не похожи и вычищаются;
 *  - null, undefined и boolean не скрываются (признак «задан / не задан» — не секрет).
 * Error, Buffer, запрос и ответ Fastify не обходятся (их сериализует pino, а заголовки чистят REDACT_PATHS).
 */

/** Имена полей-секретов (спринт 8: провайдеры платежей — Basic/подписи/ключи, вход «Log In with Telegram» — OIDC). */
export const SECRET_LOG_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "sign_string",
  "secret_key",
  "password",
  "key",
  "client_secret",
  "code",
  "code_verifier",
  "id_token",
]);

const CENSOR = "[redacted]";
/** Бизнес-код ошибки в поле `code` — не секрет (как admin-bff и py-common). */
const BUSINESS_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CAMEL1 = /([A-Z]+)([A-Z][a-z])/g;
const CAMEL2 = /([a-z0-9])([A-Z])/g;
const SEP = /[^A-Za-z0-9]+/g;

/** camelCase / kebab-case / UPPER → snake_case в нижнем регистре (`clientSecret` → `client_secret`). */
export function normLogKey(key: string): string {
  return key.replace(CAMEL1, "$1_$2").replace(CAMEL2, "$1_$2").replace(SEP, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/** Поле лога с этим именем и значением — секрет. */
export function isSecretLogField(key: string, value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") return false;
  const k = normLogKey(key);
  if (!SECRET_LOG_KEYS.has(k)) return false;
  return !(k === "code" && typeof value === "string" && BUSINESS_CODE_RE.test(value));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Рекурсивно (до 6 уровней) заменяет значения полей-секретов на "[redacted]"; исходный объект не меняется. */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretLogField(k, v) ? CENSOR : scrubSecrets(v, depth + 1);
  }
  return out;
}
