import type { ErrorBody } from "@tilhero/contracts/admin";

/** Session is gone: no cookie (A30), idle/absolute expiry, revoked after a role/password change. */
export const SESSION_LOST = new Set(["UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_REVOKED"]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly traceId: string | null;
  /** the user dismissed the step-up dialog — callers stay silent */
  cancelled = false;

  constructor(status: number, body: Partial<ErrorBody> | null, fallbackMessage = "") {
    super(body?.message || fallbackMessage || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.code || (status === 0 ? "NETWORK" : `HTTP_${status}`);
    this.details = body?.details && typeof body.details === "object" ? body.details : {};
    this.traceId = body?.trace_id ?? null;
  }

  num(key: string): number | null {
    const v = this.details[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  str(key: string): string | null {
    const v = this.details[key];
    return typeof v === "string" ? v : null;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
