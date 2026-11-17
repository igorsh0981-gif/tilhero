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
import { ErrorBodySchema } from "./schemas.js";

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
    /** Разрешён сессии с pin=false (INTERNAL_API «pin_required сессия»). */
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

/** Сессия текущего запроса (маршрут с access: "user"). */
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
  /** Добавлять details.field (контракт: PREFERENCES_INVALID {field}). */
  withField?: boolean;
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
    for (const o of overrides) {
      if (o.context && o.context !== dataVar) continue;
      if (o.field && !(field === o.field || field.startsWith(`${o.field}.`))) continue;
      return new AppError(o.status ?? 422, o.code, o.message, o.withField ? { field } : {});
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
