import type { ErrorBody } from "@tilhero/contracts/bff";
import type { MessageKey, Vars } from "../i18n";

/** Error returned by the BFF (ErrorBody) or synthesised for network / non-JSON failures. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly traceId: string | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}, traceId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.traceId = traceId;
  }

  static fromBody(status: number, body: Partial<ErrorBody> | null): ApiError {
    const code = typeof body?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(body.code) ? body.code : codeForStatus(status);
    const details = body?.details && typeof body.details === "object" ? body.details : {};
    return new ApiError(status, code, typeof body?.message === "string" ? body.message : code, details, typeof body?.trace_id === "string" ? body.trace_id : null);
  }

  /** Seconds until retry from details.retry_after (PIN_LOCKED, rate limits). */
  get retryAfter(): number | null {
    const v = this.details.retry_after;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  }

  get remaining(): number | null {
    const v = this.details.remaining;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  }
}

export function codeForStatus(status: number): string {
  if (status === 0) return "NETWORK";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502 || status === 503 || status === 504) return "SERVICE_UNAVAILABLE";
  return "UNKNOWN";
}

/** 401 codes that are business answers (wrong PIN/code) — they must NOT trigger a token refresh. */
export const BUSINESS_401 = new Set(["PIN_INVALID", "RESET_CODE_INVALID", "BIOMETRIC_INVALID", "INIT_DATA_INVALID", "INIT_DATA_EXPIRED", "INIT_DATA_REPLAYED", "REFRESH_INVALID"]);

const KNOWN: ReadonlySet<string> = new Set([
  "INIT_DATA_INVALID", "INIT_DATA_EXPIRED", "INIT_DATA_REPLAYED", "USER_DELETED", "REFRESH_INVALID", "TOKEN_EXPIRED", "SESSION_REVOKED",
  "PIN_INVALID", "PIN_LOCKED", "PIN_REQUIRED", "PIN_FORMAT", "PIN_RESET_TOO_OFTEN", "RESET_CODE_INVALID", "RESET_CODE_EXPIRED",
  "BIOMETRIC_INVALID", "PREFERENCES_INVALID", "PREFERENCES_VERSION_CONFLICT", "AIRPORT_UNKNOWN", "AGE_CONFIRMATION_REQUIRED",
  "POLICY_VERSION_OUTDATED", "SUPPORT_CATEGORY_INVALID", "SUPPORT_TICKET_NOT_FOUND", "SUPPORT_TICKET_CLOSED", "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE", "VALIDATION_ERROR", "SERVICE_UNAVAILABLE", "NETWORK", "EVENTS_UNAVAILABLE", "EVENT_NOT_FOUND",
  "OFFERS_UNAVAILABLE", "OFFER_DEPARTURE_INVALID",
  "WATCH_LIMIT", "EVENT_PAST", "VERSION_CONFLICT", "WATCH_NOT_FOUND", "EVENT_CANCELLED", "WATCH_ENDED", "WATCH_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "RATE_LIMIT_UNAVAILABLE",
]);

/**
 * Codes shown with the text of another code. Server-side faults (upstream down, internal auth between
 * services, actor checks) all read as «Сервис временно недоступен» — the client cannot fix them.
 */
const ALIAS: Readonly<Record<string, string>> = {
  UPSTREAM_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "SERVICE_UNAVAILABLE",
  TOKEN_INVALID: "SESSION_REVOKED",
  UNAUTHORIZED: "SESSION_REVOKED",
  INVALID_JSON: "VALIDATION_ERROR",
};
const SERVER_FAULT = /^(INTERNAL_|ACTOR_|CALLER_)/;

/** The dictionary code an error is shown with (see ALIAS / SERVER_FAULT). */
export function displayCode(err: ApiError): string {
  if (SERVER_FAULT.test(err.code)) return "SERVICE_UNAVAILABLE";
  const code = ALIAS[err.code] ?? err.code;
  if (KNOWN.has(code)) return code;
  return err.status >= 500 ? "SERVICE_UNAVAILABLE" : err.status === 413 ? "PAYLOAD_TOO_LARGE" : "UNKNOWN";
}

/**
 * Localised message for an error, by business code (the server's Russian `message` is never shown —
 * clients translate by `code`, ARCHITECTURE «Ошибки»).
 */
export function errorText(err: unknown, t: (key: MessageKey, vars?: Vars) => string, mmss: (s: number) => string): string {
  if (!(err instanceof ApiError)) return t("err.UNKNOWN");
  // 409 PIN_REQUIRED (biometrics without a PIN) differs from the 423 session gate
  if (err.code === "PIN_REQUIRED" && err.status === 409) return t("err.PIN_NOT_SET");
  // sprint 9: one 429 everywhere — «повторите через ⌈N⌉ с» (no automatic repeat); no retry_after — «чуть позже»
  if (err.code === "RATE_LIMITED") return err.retryAfter != null ? t("err.RATE_LIMITED.wait", { n: Math.ceil(err.retryAfter) }) : t("err.RATE_LIMITED");
  const code = displayCode(err);
  const vars: Vars = {
    remaining: err.remaining ?? 0,
    time: mmss(err.retryAfter ?? 300),
    iata: typeof err.details.iata === "string" ? err.details.iata.slice(0, 8) : "",
  };
  return t(`err.${code}` as MessageKey, vars);
}
