/**
 * Общие HTTP-помощники BFF: типизированный инстанс, формат ошибок валидации, описания ответов для OpenAPI.
 */
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifySchemaValidationError,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { AppError } from "@tilhero/ts-common";
import type { AccessClaims } from "./tokens.js";
import { ErrorBodySchema, TIMEZONE_PATTERN } from "./schemas.js";

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

declare module "fastify" {
  interface FastifyContextConfig {
    /** public — без Bearer (лимит по IP); user — Bearer access JWT. Нет значения — служебный маршрут. */
    access?: "public" | "user";
    /** Разрешён сессии с pin=false (код родителя задан, но ещё не подтверждён). */
    pinExempt?: boolean;
    /** Лимит по IP для публичного маршрута: session — 10/мин на /v1/session/telegram, public — общий. */
    ipLimit?: "session" | "public";
    /** Операция с PIN/биометрией — отдельный лимит 5/мин на пользователя (бакет "pin").
     *  "reset" — ввод кода сброса: свой бакет "pin_reset" того же размера. Иначе 5 неверных PIN, которые и привели
     *  к блокировке, съедали лимит, и восстановление по коду из бота получало 429 в ту же минуту (e2e, дефект BFF-2).
     *  Сам код защищён в identity-consent: 5 попыток на код, запрос кода не чаще 1/60 с и 5/сутки. */
    pinLimited?: boolean | "reset";
  }
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

/** Сессия текущего запроса (маршрут с access: "user"): accountId — sub, learnerId — lrn. */
export function authOf(req: { auth?: AccessClaims }): AccessClaims {
  if (!req.auth) throw new AppError(401, "UNAUTHORIZED", "Требуется авторизация");
  return req.auth;
}

// ---------- ошибки валидации ----------

type DataVar = "body" | "querystring" | "params" | "headers";

export interface ValidationOverride {
  /** Где произошла ошибка (body/querystring/params/headers); не задано — где угодно. */
  context?: DataVar;
  /** Поле (через точку: budget.preset) или его префикс; не задано — любое. */
  field?: string;
  status?: number;
  code: string;
  message: string;
  /** Только эти правила Ajv (pattern, maxLength…); не задано — любое. */
  keywords?: string[];
  /** Добавлять details.field (контракт: PIN_FORMAT {field}). */
  withField?: boolean;
  /** Добавлять details.reason — правило схемы (контракт: PLAN_INVALID {field, reason}). */
  withReason?: boolean;
}

function fieldOf(e: FastifySchemaValidationError | undefined): string {
  if (!e) return "";
  const base = (e.instancePath ?? "").split("/").filter(Boolean).join(".");
  const params = (e.params ?? {}) as Record<string, unknown>;
  const extra =
    typeof params.missingProperty === "string"
      ? params.missingProperty
      : typeof params.additionalProperty === "string"
        ? params.additionalProperty
        : "";
  return [base, extra].filter(Boolean).join(".");
}

/** Повторяющийся параметр строки запроса (country=UZ&country=KZ) — массив: индекс элемента в имени поля не нужен
 *  клиенту (country.1 → country). */
const queryField = (field: string, dataVar: string): string => (dataVar === "querystring" ? field.replace(/\.\d+(?=\.|$)/g, "") : field);

function sanitize(errors: FastifySchemaValidationError[], dataVar: string) {
  // Без значений из запроса: только путь, правило и параметры правила.
  return errors.slice(0, 5).map((e) => ({
    field: queryField(fieldOf(e), dataVar),
    rule: e.keyword,
    message: e.message ?? "",
    params: e.params ?? {},
  }));
}

/** schemaErrorFormatter: 422 VALIDATION_ERROR (или код из overrides) в едином формате ошибок. */
export function schemaErrors(overrides: ValidationOverride[] = []) {
  return (errors: FastifySchemaValidationError[], dataVar: string): Error => {
    const field = queryField(fieldOf(errors[0]), dataVar);
    const keyword = errors[0]?.keyword ?? "";
    for (const o of overrides) {
      if (o.context && o.context !== dataVar) continue;
      if (o.field && !(field === o.field || field.startsWith(`${o.field}.`))) continue;
      if (o.keywords && !o.keywords.includes(keyword)) continue;
      return new AppError(o.status ?? 422, o.code, o.message, {
        ...(o.withField ? { field } : {}),
        ...(o.withReason ? { reason: keyword } : {}),
      });
    }
    return new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", {
      in: dataVar,
      field,
      errors: sanitize(errors, dataVar),
    });
  };
}

// ---------- OpenAPI ----------

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Некорректный запрос",
  401: "Нет/неверная сессия или неверные учётные данные",
  403: "Нет доступа",
  404: "Не найдено",
  409: "Конфликт состояния",
  410: "Ресурс больше недоступен",
  422: "Ошибка валидации",
  423: "Требуется PIN / PIN заблокирован",
  429: "Превышен лимит запросов (Retry-After)",
  503: "Домен недоступен (UPSTREAM_UNAVAILABLE)",
};

/** Описания ответов-ошибок (ErrorBody) для OpenAPI. */
export function errorResponses(...statuses: number[]) {
  const out: Record<number, typeof ErrorBodySchema> = {};
  for (const s of [...new Set([...statuses, 422, 429, 503])]) {
    out[s] = { ...ErrorBodySchema, description: ERROR_DESCRIPTIONS[s] ?? "Ошибка" } as typeof ErrorBodySchema;
  }
  return out;
}

export const BEARER = [{ bearerAuth: [] as string[] }];

/** Ошибки формата PIN в теле → 422 PIN_FORMAT {field} (контракт bff.ts), а не общий VALIDATION_ERROR. */
export const PIN_FORMAT = schemaErrors(
  ["pin", "current_pin", "new_pin"].map((field) => ({
    context: "body" as const,
    field,
    code: "PIN_FORMAT",
    message: "PIN — 4 или 6 цифр",
    withField: true,
  })),
);

// ---------- Idempotency-Key ----------

const IDEMPOTENCY_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Заголовок Idempotency-Key (UUID): обязателен для создающих команд (422 IDEMPOTENCY_KEY_REQUIRED), пробрасывается
 *  в домен как есть (в нижнем регистре) — повтор с тем же ключом возвращает тот же результат. */
export function idempotencyKey(req: { headers: Record<string, string | string[] | undefined> }, required: boolean): string | undefined {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? undefined : raw?.trim();
  if (key && IDEMPOTENCY_RE.test(key)) return key.toLowerCase();
  if (!key && !required && raw === undefined) return undefined;
  throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key (UUID)");
}

// ---------- часовой пояс клиента ----------

const TIMEZONE_RE = new RegExp(TIMEZONE_PATTERN);

/** Заголовок X-Timezone — IANA-зона устройства (Mini App шлёт его с каждым запросом, как Accept-Language).
 *  Нужен learning-plan, чтобы план по умолчанию создавался в зоне клиента (INTERNAL_API §10–§11, QA D-03).
 *  Необязательный: нет или не формата IANA — undefined (запрос не отклоняется, домен возьмёт зону по умолчанию). */
export function clientTimezone(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const raw = req.headers["x-timezone"];
  const tz = typeof raw === "string" ? raw.trim() : undefined;
  return tz && tz.length <= 64 && TIMEZONE_RE.test(tz) ? tz : undefined;
}

// ---------- язык ученика ----------

export interface LocaleSource {
  query: unknown;
  headers: Record<string, string | string[] | undefined>;
}
/** Язык ученика: ?locale= (ru|uz) → Accept-Language (Mini App шлёт язык интерфейса) → ru. */
export function localeOf(req: LocaleSource): "ru" | "uz" {
  const q = (req.query as { locale?: unknown } | undefined)?.locale;
  if (q === "ru" || q === "uz") return q;
  const raw = req.headers["accept-language"];
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim().toLowerCase().slice(0, 2);
  return first === "uz" ? "uz" : "ru";
}

// ---------- детский профиль ----------

/** Детский профиль 6–13 (lrn ≠ sub): действие доступно только в профиле самого аккаунта. */
export function forbidInChildProfile(auth: AccessClaims, code: "ADULT_REQUIRED" | "INVITES_NOT_ALLOWED"): void {
  if (auth.learnerId === auth.accountId) return;
  throw code === "INVITES_NOT_ALLOWED"
    ? new AppError(403, code, "В детском профиле приглашения недоступны — их отправляет и принимает родитель")
    : new AppError(403, code, "Действие доступно только взрослому — перейдите в профиль родителя");
}
