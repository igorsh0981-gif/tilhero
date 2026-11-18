/**
 * Общее для маршрутов спринта 7: команды с синхронным аудитом домена (15 с, без повторов, 503 → AUDIT_UNAVAILABLE),
 * причина, период учёта, ответ домена → строгая нормализация + имена сотрудников.
 */
import { AppError, type UpstreamError } from "@tilhero/ts-common";
import type { BffContext } from "../context.js";
import { validationError, type StaffAuth } from "../http.js";
import { parseDomain, withNames, type Codec } from "../codec.js";
import { enumOf, str } from "../schemas.js";

/** Команда с синхронным аудитом домена: аудит 5 с + повтор и запись — как у kill switch и лимитов 6.1. */
export const COMMAND_TIMEOUT_MS = 15_000;

/** 503 домена «аудит недоступен» → AUDIT_UNAVAILABLE: ничего не изменено, можно повторить. */
export function auditDown(err: UpstreamError): AppError | undefined {
  if (err.status !== 503) return undefined;
  if (err.code !== "AUDIT_UNAVAILABLE" && err.details?.service !== "audit") return undefined;
  return new AppError(503, "AUDIT_UNAVAILABLE", "Журнал аудита недоступен — изменение не выполнено. Повторите позже", { service: "audit" });
}

/** Опции вызова команды (без повторов: повтор после таймаута дал бы двойной аудит). */
export const command = (idempotencyKey?: string) => ({
  timeoutMs: COMMAND_TIMEOUT_MS,
  retries: 0,
  mapServerError: auditDown,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

export const REASON_IN = str(3, 300);

/** Причина после trim: от 3 символов. */
export function reasonOf(v: string | undefined, field = "reason"): string {
  const r = (v ?? "").trim();
  if (r.length < 3) throw validationError(field, "Причина — от 3 символов");
  return r;
}

/** Ответ домена → контракт (испорченный — 503 UPSTREAM_UNAVAILABLE {service}) + имена сотрудников. */
export async function respond<T>(ctx: BffContext, auth: StaffAuth, service: string, c: Codec<T>, body: unknown): Promise<T> {
  return withNames(ctx, auth, parseDomain(ctx, service, c, body));
}

// ---------------------------------------------------------------- период учёта

export const PERIOD_Q = enumOf(["today", "7d", "30d"]);
export const DATE_Q = str(10, 10, { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** period (today | 7d | 30d, по умолчанию 7d) или явные from/to (даты UTC, to включительно) → query ai-control. */
export function periodQuery(now: number, q: { period?: string; from?: string; to?: string }): { from: string; to: string } {
  if (q.from || q.to) {
    if (!q.from || !q.to) throw validationError(q.from ? "to" : "from", "Нужны обе даты периода", "querystring");
    if (q.from > q.to) throw validationError("from", "Начало периода позже конца", "querystring");
    return { from: q.from, to: q.to };
  }
  const days = q.period === "today" ? 1 : q.period === "30d" ? 30 : 7;
  return { from: day(now - (days - 1) * 86_400_000), to: day(now) };
}
