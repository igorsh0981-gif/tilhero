/**
 * Вызовы ai-gateway с защитой от утечки ключа провайдера ИИ (ADM-AGENT, решения владельца спринта 4): ключ — только
 * переменная `ANTHROPIC_API_KEY` ai-gateway, в админке — лишь «задан / не задан». Если ai-gateway вдруг пришлёт поле
 * с именем ключа или строку вида ключа (в теле ответа или в ErrorBody 4xx) — клиенту 503 UPSTREAM_UNAVAILABLE
 * {service: "ai-gateway"}, в лог — только путь поля, без значения.
 */
import { AppError } from "@tilhero/ts-common";
import type { BffContext } from "./context.js";
import { findProviderKey } from "./contractAi.js";
import { DOMAIN, upstreamUnavailable, type CallOptions, type DomainResponse } from "./upstream.js";

export const AI_SERVICE = DOMAIN.aiGateway;

function reject(ctx: BffContext, path: string): AppError {
  ctx.log.error(
    { upstream: AI_SERVICE, upstream_code: "PROVIDER_KEY_IN_RESPONSE", field: path.replace(/[^\w.$[\]-]/g, "?").slice(0, 200) },
    "ai-gateway response looks like it carries a provider key — rejected",
  );
  return upstreamUnavailable(AI_SERVICE);
}

/** Тело ответа ai-gateway без признаков ключа провайдера; иначе AppError 503. */
export function assertNoProviderKey(ctx: BffContext, body: unknown, where = "$"): void {
  const hit = findProviderKey(body, where);
  if (hit) throw reject(ctx, hit);
}

/** Вызов ai-gateway: тело ответа и ErrorBody ошибки проверяются на ключ провайдера. */
export async function aiCall<T = unknown>(ctx: BffContext, method: string, path: string, ro: CallOptions = {}): Promise<DomainResponse<T>> {
  let res: DomainResponse<T>;
  try {
    res = await ctx.domains.aiGateway.call<T>(method, path, ro);
  } catch (err) {
    if (err instanceof AppError) {
      const hit = findProviderKey({ message: err.message, details: err.details }, "$error");
      if (hit) throw reject(ctx, hit);
    }
    throw err;
  }
  assertNoProviderKey(ctx, res.body);
  return res;
}

export async function aiGet<T = unknown>(ctx: BffContext, path: string, ro: CallOptions = {}): Promise<T> {
  return (await aiCall<T>(ctx, "GET", path, ro)).body;
}
