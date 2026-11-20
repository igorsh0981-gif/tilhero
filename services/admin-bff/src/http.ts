/**
 * Общие HTTP-помощники admin-bff: тип приложения, конфигурация маршрута (доступ), контекст сотрудника запроса,
 * формат ошибок валидации.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchemaValidationError } from "fastify";
import type { Permission, StaffStatus, StaffSummary } from "@tilhero/contracts/admin";
import { AppError, type Actor } from "@tilhero/ts-common";
import type { Effective, Guard, RateClass } from "./rbac.js";
import { IDEMPOTENCY_RE, IF_MATCH_RE } from "./schemas.js";
import type { SessionData } from "./sessions.js";

export type App = FastifyInstance;

/** principal из admin-identity (GET /internal/v1/staff/{id}/principal и шаги входа). */
export interface Principal {
  staff: StaffSummary;
  permissions: string[];
  mfa_enabled: boolean;
  must_change_password: boolean;
  session_version: number;
  status: StaffStatus;
}

/** Контекст сотрудника проверенного запроса (сессионный маршрут). */
export interface StaffAuth {
  /** Непрозрачный id из cookie — секрет: не логировать, не отдавать в домены. */
  sessionId: string;
  /** Публичный идентификатор сессии (sha256) — для аудита и logout в admin-identity. */
  publicSessionId: string;
  session: SessionData;
  principal: Principal;
  effective: Effective;
  actor: Actor;
}

/** Контекст запроса уровня sessionOnly (logout): сессия без principal. */
export interface SessionAuth {
  /** Непрозрачный id из cookie — секрет: не логировать, не отдавать в домены. */
  sessionId: string;
  publicSessionId: string;
  session: SessionData;
}

declare module "fastify" {
  interface FastifyContextConfig {
    access?: "public" | "session";
    guard?: Guard;
    stepUp?: boolean;
    rate?: RateClass;
    sessionOnly?: boolean;
  }
  interface FastifyRequest {
    staff?: StaffAuth;
    sessionAuth?: SessionAuth;
  }
}

export function staffOf(req: { staff?: StaffAuth }): StaffAuth {
  if (!req.staff) throw new AppError(401, "UNAUTHORIZED", "Требуется вход");
  return req.staff;
}

export function sessionOf(req: { sessionAuth?: SessionAuth }): SessionAuth {
  if (!req.sessionAuth) throw new AppError(401, "UNAUTHORIZED", "Требуется вход");
  return req.sessionAuth;
}

export function hasPermission(auth: StaffAuth, p: Permission): boolean {
  return auth.effective.permissions.includes(p);
}

// ---------- ошибки валидации ----------

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

/** schemaErrorFormatter: 422 VALIDATION_ERROR {in, field, errors} — без значений из запроса. */
export function schemaErrors() {
  return (errors: FastifySchemaValidationError[], dataVar: string): Error =>
    new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", {
      in: dataVar,
      field: fieldOf(errors[0]),
      errors: errors.slice(0, 5).map((e) => ({
        field: fieldOf(e),
        rule: e.keyword,
        message: e.message ?? "",
        params: e.params ?? {},
      })),
    });
}

export function validationError(field: string, message: string, inPart = "body"): AppError {
  return new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", {
    in: inPart,
    field,
    errors: [{ field, rule: "required", message, params: {} }],
  });
}

/**
 * Idempotency-Key создающей команды (пробрасывается в домен): нет и обязателен → 422 IDEMPOTENCY_KEY_REQUIRED,
 * неверный формат → 422 IDEMPOTENCY_KEY_INVALID (admin.ts: 8..128, [A-Za-z0-9_\-:.]).
 */
export function idempotencyKeyOf(req: FastifyRequest, required: boolean): string | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) {
    if (required) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key");
    return undefined;
  }
  if (typeof raw !== "string" || !IDEMPOTENCY_RE.test(raw)) {
    throw new AppError(422, "IDEMPOTENCY_KEY_INVALID", "Некорректный Idempotency-Key (8–128 символов A-Z a-z 0-9 . _ : -)");
  }
  return raw;
}

/**
 * If-Match оптимистической блокировки (updated_at черновика версии агента, статьи словаря курса) → домену как есть;
 * неверный формат → 422 до домена; нет заголовка — решает домен (428 IF_MATCH_REQUIRED).
 */
export function ifMatchOf(raw: string | string[] | undefined): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "string" || !IF_MATCH_RE.test(raw)) throw validationError("if-match", "Некорректный If-Match", "headers");
  return { "if-match": raw };
}

/** Ответ домена — повтор команды по тому же Idempotency-Key → клиенту `Idempotent-Replayed: true`. */
export function passReplayed(reply: FastifyReply, res: { replayed?: boolean }): void {
  if (res.replayed) void reply.header("idempotent-replayed", "true");
}
