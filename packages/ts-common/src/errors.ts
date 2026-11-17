/**
 * Единый формат ошибок (ТЗ «API, Events, Support» §6) — тот же, что у Python-сервисов:
 *   {"code":"SUPPORT_TICKET_NOT_FOUND","message":"…","trace_id":"…","details":{}}
 */
import { currentContext } from "./context.js";

export interface ErrorBody {
  code: string;
  message: string;
  trace_id: string;
  details: Record<string, unknown>;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.message, this.details);
  }
}

export function errorBody(code: string, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return { code, message, trace_id: currentContext().traceId, details };
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = "UNAUTHORIZED", message = "Требуется авторизация") =>
  new AppError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "Недостаточно прав", details?: Record<string, unknown>) =>
  new AppError(403, code, message, details);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(409, code, message, details);
export const tooMany = (code: string, message: string, retryAfter?: number) =>
  new AppError(429, code, message, retryAfter ? { retry_after: retryAfter } : {});
export const unavailable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(503, code, message, details);
