/**
 * Общие шаги маршрутов-прокси: вызов домена с actor → строгий разбор ответа кодеком контракта → имена сотрудников
 * (`*_name`) → статус домена (201 / 202 / 200 no-op) и `Idempotent-Replayed` клиенту.
 */
import type { FastifyReply } from "fastify";
import { parseDomain, withNames, type Codec } from "../codec.js";
import type { BffContext } from "../context.js";
import { maskUsername } from "../contract.js";
import { hasPermission, passReplayed, type StaffAuth } from "../http.js";
import type { DomainResponse } from "../upstream.js";

export interface RespondOptions {
  /** Дополнить `*_name` через staff/lookup. */
  names?: boolean;
}

/** Ответ домена → тело контракта (испорченное → 503 UPSTREAM_UNAVAILABLE {service}). */
export async function shaped<T>(ctx: BffContext, auth: StaffAuth, service: string, c: Codec<T>, body: unknown, o: RespondOptions = {}): Promise<T> {
  const v = parseDomain(ctx, service, c, body);
  return o.names ? withNames(ctx, auth, v) : v;
}

/** Ответ команды: тело по кодеку, статус домена, `Idempotent-Replayed`. */
export async function relay<T>(
  ctx: BffContext,
  auth: StaffAuth,
  reply: FastifyReply,
  service: string,
  c: Codec<T>,
  res: DomainResponse<unknown>,
  o: RespondOptions = {},
): Promise<FastifyReply> {
  passReplayed(reply, res);
  const body = await shaped(ctx, auth, service, c, res.body, o);
  return reply.status(res.status).send(body);
}

/** Схема ответа маршрута из кодека: `{"2xx": schema}` или по статусам. */
export const out = (c: Codec<unknown>) => ({ "2xx": c.schema });

/**
 * Защита в глубину (ревью T2-3, admin.ts AdminLearnerRow): полный @username — только сотруднику с
 * users.sensitive.read. Маскирует домен user-admin по actor; если он вернул полный username сотруднику без права,
 * BFF маскирует сам (`ig•••81`, короче 5 — `•••`). Обходит строки реестра, детей, опекуна и сводку ученика в тикете.
 */
export function redactUsernames<T>(auth: StaffAuth, value: T): T {
  if (hasPermission(auth, "users.sensitive.read")) return value;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.username === "string" && "user_id" in o) o.username = maskUsername(o.username);
    for (const x of Object.values(o)) visit(x);
  };
  visit(value);
  return value;
}
