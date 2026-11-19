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

/** 401 codes that are business answers (wrong PIN / reset code / biometry, bad initData) — they must NOT trigger a
 *  token refresh. */
export const BUSINESS_401 = new Set([
  "PIN_INVALID", "RESET_CODE_INVALID", "BIOMETRIC_INVALID", "INIT_DATA_INVALID", "INIT_DATA_EXPIRED", "INIT_DATA_REPLAYED", "REFRESH_INVALID",
]);

/** Codes with their own text in the dictionaries (err.<CODE>). The server's Russian `message` is never shown. */
export const KNOWN_CODES = [
  "INIT_DATA_INVALID", "INIT_DATA_EXPIRED", "INIT_DATA_REPLAYED", "USER_DELETED", "REFRESH_INVALID", "TOKEN_EXPIRED",
  "SESSION_REVOKED", "PIN_REQUIRED", "PIN_INVALID", "PIN_LOCKED", "VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMITED",
  "SERVICE_UNAVAILABLE", "NETWORK", "PAYLOAD_TOO_LARGE", "UNKNOWN",
  "LEARNER_NOT_FOUND", "QUIET_HOURS_INVALID", "AGE_ALREADY_SET", "CHILDREN_LIMIT", "ADULT_REQUIRED",
  "GUARDIAN_CONSENT_NOT_REQUIRED", "GUARDIAN_CONSENT_NOT_FOUND", "GUARDIAN_CONSENT_EXPIRED", "GUARDIAN_CONSENT_SELF",
  "GUARDIAN_CONSENT_REQUIRED", "POLICY_VERSION_OUTDATED", "CONSENT_REQUIRED_PURPOSES",
  "CONSENT_REQUIRED", "CONSENT_PURPOSES_INVALID",
  "PLAN_VERSION_CONFLICT", "PLAN_INVALID", "PLAN_INCOMPLETE", "ACTIVITY_INVALID", "IDEMPOTENCY_KEY_REQUIRED", "IDEMPOTENCY_KEY_REUSED",
  "INVITES_NOT_ALLOWED", "INVITES_LIMIT", "INVITE_NOT_FOUND", "INVITE_SELF", "INVITE_ALREADY_USED", "INVITE_EXPIRED",
  "INVITE_REVOKED", "FAMILY_ALREADY_MEMBER", "FAMILY_NOT_FOUND", "FAMILY_FULL", "ALREADY_FRIENDS",
  "PIN_FORMAT", "PIN_ALREADY_SET", "PIN_NOT_SET", "PIN_RESET_TOO_OFTEN", "RESET_CODE_INVALID", "RESET_CODE_EXPIRED", "BIOMETRIC_INVALID",
  "DELETION_CONFIRMATION_REQUIRED", "USER_DELETION_REQUESTED", "USER_DISABLED",
  "SUPPORT_CATEGORY_INVALID", "SUPPORT_TICKET_NOT_FOUND", "SUPPORT_TICKET_CLOSED", "SUPPORT_RATE_LIMITED", "SUPPORT_TOO_MANY_OPEN",
  // sprint 3: diagnostics, catalog, learning-plan
  "DIAGNOSTIC_SESSION_NOT_FOUND", "DIAGNOSTIC_RESULT_NOT_FOUND", "DIAGNOSTIC_TEST_NOT_FOUND", "DIAGNOSTIC_SESSION_EXPIRED",
  "DIAGNOSTIC_SESSION_CLOSED", "DIAGNOSTIC_TOO_SOON", "ITEM_NOT_CURRENT", "PAIR_NOT_AVAILABLE", "FOLLOWUP_NOT_AVAILABLE",
  "DIAGNOSTIC_EMPTY", "ANSWER_INVALID", "KIDS_NOT_ALLOWED", "MEDIA_REQUEST_LIMIT", "MEDIA_NOT_AVAILABLE", "AUDIO_NOT_FOUND",
  "SCENARIO_NOT_FOUND", "CATALOG_UNAVAILABLE", "COURSE_NOT_FOUND",
  // sprint 4: lessons, assessment
  "LESSON_NOT_AVAILABLE", "SESSION_NOT_FOUND", "SESSION_ACTIVE", "SESSION_STATE", "STEP_NOT_CURRENT", "HINTS_NOT_ALLOWED",
  "NO_EXERCISES", "APPEAL_EXISTS", "APPEAL_WINDOW_CLOSED", "APPEAL_NOT_ALLOWED", "EVALUATION_NOT_FOUND", "FREE_TEXT_NOT_ALLOWED",
  "SIMPLER_NOT_AVAILABLE", "RETRY_NOT_AVAILABLE", "NOTHING_TO_REVIEW", "AI_BUSY",
] as const;
export type KnownCode = (typeof KNOWN_CODES)[number];
const KNOWN: ReadonlySet<string> = new Set(KNOWN_CODES);

/**
 * Codes shown with the text of another code. Server-side faults (upstream down, internal auth between services)
 * all read as «Сервис временно недоступен» — the client cannot fix them.
 */
const ALIAS: Readonly<Record<string, KnownCode>> = {
  UPSTREAM_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  RATE_LIMIT_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "SERVICE_UNAVAILABLE",
  TOKEN_INVALID: "SESSION_REVOKED",
  UNAUTHORIZED: "SESSION_REVOKED",
  INVALID_JSON: "VALIDATION_ERROR",
  IDEMPOTENCY_KEY_INVALID: "IDEMPOTENCY_KEY_REUSED",
};

/** 403 CONSENT_REQUIRED {purpose} (bff.ts): the purpose of the policy the action needs — "social" (invitations and the
 *  family) or "terms" (the user's own consent first, e.g. before a parent's decision). null — another error. */
export function consentRequiredPurpose(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== "CONSENT_REQUIRED") return null;
  const p = e.details.purpose;
  return typeof p === "string" ? p : "terms";
}
const SERVER_FAULT = /^(INTERNAL_|ACTOR_|CALLER_)/;

/** The dictionary code an error is shown with (see ALIAS / SERVER_FAULT). */
export function displayCode(err: ApiError): KnownCode {
  if (SERVER_FAULT.test(err.code)) return "SERVICE_UNAVAILABLE";
  const code = ALIAS[err.code] ?? err.code;
  if (KNOWN.has(code)) return code as KnownCode;
  return err.status >= 500 ? "SERVICE_UNAVAILABLE" : err.status === 413 ? "PAYLOAD_TOO_LARGE" : err.status === 404 ? "NOT_FOUND" : "UNKNOWN";
}

/** Localised message for an error, by business code (clients translate by `code`). */
export function errorText(err: unknown, t: (key: MessageKey, vars?: Vars) => string, mmss: (s: number) => string): string {
  if (!(err instanceof ApiError)) return t("err.UNKNOWN");
  if (err.code === "RATE_LIMITED") return err.retryAfter != null ? t("err.RATE_LIMITED.wait", { n: Math.ceil(err.retryAfter) }) : t("err.RATE_LIMITED");
  const code = displayCode(err);
  if (code === "PIN_INVALID" && err.remaining == null) return t("err.PIN_INVALID.plain");
  if (code === "RESET_CODE_INVALID" && err.remaining == null) return t("err.RESET_CODE_INVALID.plain");
  return t(`err.${code}` as MessageKey, { remaining: err.remaining ?? 0, time: mmss(err.retryAfter ?? 300) });
}
