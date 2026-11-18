import { ApiError } from "../api/errors";
import { DICTS, fmtCountdown, type I18n, type MessageKey } from "../i18n";

/** Human text for an admin-bff / domain error: `err.<CODE>` from the dictionary, else a generic text by status. */
export function errText(i: Pick<I18n, "t">, e: unknown): string {
  if (!(e instanceof ApiError)) return i.t("err.generic");
  const key = `err.${e.code}` as MessageKey;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(e.details)) if (typeof v === "string" || typeof v === "number") vars[k] = v;
  const ra = e.num("retry_after");
  if (ra != null) vars.retry_after = fmtCountdown(ra * 1000);
  // sprint 9 (§2.2): one 429 everywhere, no automatic repeat. The seconds are live in <RateWaitNotice> (dialogs,
  // sign-in, the shell) — a stored error text has none, so it never shows a frozen «через N с» (review of sprint 9)
  if (e.code === "RATE_LIMITED") return i.t("err.RATE_LIMITED");
  // 403 without a named permission: a generic «not allowed» instead of a visible {permission} placeholder
  if ((e.code === "PERMISSION_DENIED" || (e.status === 403 && !(key in DICTS.ru))) && vars.permission == null) return i.t("err.denied.m");
  if (key in DICTS.ru) return i.t(key, vars);
  if (e.status === 0) return i.t("err.network");
  if (e.status === 422) return i.t("err.validation");
  if (e.status === 404) return i.t("err.notFound");
  if (e.status === 409) return i.t("err.conflict");
  if (e.status === 403) return i.t("err.PERMISSION_DENIED", vars);
  if (e.status >= 500) return i.t("err.server");
  return i.t("err.generic");
}

/** toast meta line: code · trace id (never request bodies) */
export function errMeta(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  return [e.status ? `${e.status} ${e.code}` : e.code, e.traceId ? `trace ${e.traceId.slice(0, 12)}` : ""].filter(Boolean).join(" · ");
}
