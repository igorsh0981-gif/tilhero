/**
 * Общие шаги маршрутов-прокси: вызов домена с actor → строгий разбор ответа кодеком контракта → имена сотрудников
 * (`*_name`) → статус домена (201 / 202 / 200 no-op) и `Idempotent-Replayed` клиенту.
 */
import type { FastifyReply } from "fastify";
import { parseDomain, withNames, type Codec } from "../codec.js";
import type { BffContext } from "../context.js";
import { passReplayed, type StaffAuth } from "../http.js";
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
