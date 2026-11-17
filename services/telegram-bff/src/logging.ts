/**
 * Логи BFF: JSON в stdout, trace_id/correlation_id/user_pid из контекста запроса, без PII.
 *
 * Два уровня защиты:
 *  1) redact-пути pino — REDACT_PATHS из ts-common + свои (buildBase({ redactPaths }));
 *  2) рекурсивная вычистка известных ключей в любом месте объекта лога (как tilhero_common.logging.redact),
 *     чтобы случайный `log.info({ body })` не унёс initData, PIN, код или токен.
 */

export const EXTRA_REDACT_PATHS = [
  "req.body.biometric_token",
  "req.body.subject",
  "req.body.confirm_word",
  "req.query.initData",
  "req.query.init_data",
  'req.headers["x-telegram-init-data"]',
  'res.headers["set-cookie"]',
];

/** Ключи, значения которых никогда не пишутся в лог (сравнение без учёта регистра). */
export const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "init_data",
  "initdata",
  "pin",
  "current_pin",
  "new_pin",
  "code_value",
  "reset_code",
  "token",
  "access_token",
  "refresh_token",
  "biometric_token",
  "password",
  "secret",
  "text",
  "message_text",
  "subject",
  "confirm_word",
  "q",
  "telegram_user_id",
  "username",
  "first_name",
  "last_name",
  "display_name",
  "teen_display_name",
  "inviter_display_name",
  "hash",
  // TilHero: ссылки и параметры запуска несут токены приглашений и согласия родителя
  "link",
  "start_param",
  "startapp",
]);

const CENSOR = "[redacted]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (!isPlainObject(value)) return value; // Error, FastifyRequest/Reply — их сериализуют и чистят redact-пути pino
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? CENSOR : scrub(v, depth + 1);
  }
  return out;
}

export interface LogSink {
  write(msg: string): void;
}
