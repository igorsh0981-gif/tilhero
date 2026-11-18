/**
 * Secret redaction for anything the UI renders from arbitrary JSON (audit before/after, error details) or
 * would ever write to a diagnostic log. Passwords, TOTP codes, MFA secrets, challenges, CSRF tokens and
 * cookies must never be shown or logged (sprint brief, security rules) — even if a backend leaked one.
 */
export const REDACTED = "••• redacted";

const SECRET_KEYS = new Set([
  "password",
  "current_password",
  "new_password",
  "temporary_password",
  "secret",
  "mfa_secret",
  "otpauth_uri",
  "challenge",
  "csrf_token",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "cookie",
  "set-cookie",
  "authorization",
  "x-csrf-token",
  "api_key",
  "recovery_codes",
]);

const isSecretKey = (k: string) => {
  const key = k.toLowerCase();
  return SECRET_KEYS.has(key) || /(^|_)(password|secret|token)$/.test(key);
};

/** TOTP / step-up codes travel as {code: "123456"}; ordinary error codes (PERMISSION_DENIED) are kept. */
const isOtpCode = (k: string, v: unknown) => k.toLowerCase() === "code" && typeof v === "string" && /^\d{6,8}$/.test(v);

const looksSecretValue = (v: string) => /^otpauth:\/\//i.test(v) || /__Host-tilhero_admin=/i.test(v);

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return (looksSecretValue(value) ? REDACTED : value) as T;
  if (Array.isArray(value)) return value.map((x) => redactSecrets(x, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // flags and counters next to secrets (must_change_password: true, password_changed_at …) are not secrets:
      // only a string/object value under a secret-looking key is hidden
      const secretValue = typeof v === "string" || (typeof v === "object" && v !== null);
      out[k] = (secretValue && isSecretKey(k)) || isOtpCode(k, v) ? REDACTED : redactSecrets(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
