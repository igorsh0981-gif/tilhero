/**
 * Контекст запроса (trace_id, correlation_id, псевдонимный user id) через AsyncLocalStorage.
 * Значения попадают в логи, ответы и исходящие вызовы доменных сервисов.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export const TRACE_HEADER = "x-trace-id";
export const CORRELATION_HEADER = "x-correlation-id";
export const CAUSATION_HEADER = "x-causation-id";

export interface RequestContext {
  traceId: string;
  correlationId: string;
  causationId?: string;
  userPid?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newId(): string {
  return randomUUID().replaceAll("-", "");
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function enterContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? { traceId: newId(), correlationId: newId() };
}

/** Псевдонимный ID для логов (ТЗ: user pseudonymous ID) — совпадает с Python: "u_" + sha256[:12]. */
export function pseudonymize(userId: string | undefined | null): string | undefined {
  if (!userId) return undefined;
  return "u_" + createHash("sha256").update(String(userId)).digest("hex").slice(0, 12);
}

export function outgoingHeaders(): Record<string, string> {
  const ctx = currentContext();
  const headers: Record<string, string> = {
    [TRACE_HEADER]: ctx.traceId,
    [CORRELATION_HEADER]: ctx.correlationId,
  };
  if (ctx.causationId) headers[CAUSATION_HEADER] = ctx.causationId;
  return headers;
}
