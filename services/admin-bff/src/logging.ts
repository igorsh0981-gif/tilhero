/**
 * Логи admin-bff: JSON в stdout, trace_id/correlation_id и псевдоним сотрудника из контекста, без PII и секретов.
 *
 * Два уровня защиты (как telegram-bff):
 *  1) redact-пути pino — REDACT_PATHS из ts-common + свои (cookie, X-CSRF-Token, пароли, коды, challenge);
 *  2) рекурсивная вычистка известных ключей в любом месте объекта лога.
 * Access-лог пишет шаблон маршрута (не URL: в query бывают q=@username, email и т. п.).
 */

export const EXTRA_REDACT_PATHS = [
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  "req.body.password",
  "req.body.current_password",
  "req.body.new_password",
  "req.body.challenge",
  "req.body.email",
  "req.body.reason",
  "req.body.note",
];

/** Ключи, значения которых никогда не пишутся в лог (сравнение без учёта регистра). */
export const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "csrf_token",
  "x-internal-token",
  "password",
  "current_password",
  "new_password",
  "temporary_password",
  "challenge",
  "secret",
  "otpauth_uri",
  "token",
  "session_id_raw",
  "email",
  "account",
  "value",
  "text",
  "note",
  "reason",
  "q",
  "username",
  "display_name",
  "first_name",
  "last_name",
  "telegram_user_id",
  "user_agent",
  "prompt",
  "response",
]);

const CENSOR = "[redacted]";
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    // "code": бизнес-коды ошибок (UPPER_SNAKE) оставляем, всё прочее (TOTP и т. п.) — вычищаем
    const secretCode = key === "code" && !(typeof v === "string" && ERROR_CODE_RE.test(v));
    out[k] = SENSITIVE_KEYS.has(key) || secretCode ? CENSOR : scrub(v, depth + 1);
  }
  return out;
}

export interface LogSink {
  write(msg: string): void;
}
