import { uuid } from "../lib/ids";
import { ApiError, SESSION_LOST } from "./errors";
import { fallbackPolicy, rateLimits } from "../lib/rateLimit";

export const API_PREFIX = "/admin/v1";

export interface ClientHooks {
  /** 401 UNAUTHORIZED / SESSION_EXPIRED / SESSION_REVOKED outside the sign-in flow → back to the login screen. */
  onSessionLost?(err: ApiError): void;
  /** 403 STEP_UP_REQUIRED → ask for a fresh TOTP; resolve true when /auth/step-up succeeded (the request is retried). */
  onStepUp?(err: ApiError): Promise<boolean>;
  /** any answer from admin-bff (the server-side idle timer was touched) */
  onServerTouch?(): void;
  /** a fresh Me after the session id was rotated in another tab (step-up / password change) */
  onMe?(me: { csrf_token: string }): void;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Idempotency-Key for creating commands; pass `true` to generate one (kept for the step-up retry). */
  idempotencyKey?: string | true;
  /** default true: 403 STEP_UP_REQUIRED opens the TOTP dialog and repeats the request once */
  stepUp?: boolean;
  /**
   * Background poll (queue/ticket/sidebar counters): sent with `X-Background: 1` — admin-bff does not extend the
   * idle session for it, and it does not count as the operator's activity on the client either.
   */
  background?: boolean;
  /** extra request headers (If-Match of the agent version draft); never secrets */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Pre-session sign-in steps answer 401 for wrong credentials/codes — that is not a lost session. Everything else
 * (including the in-session password change and step-up) with 401 UNAUTHORIZED / SESSION_EXPIRED / SESSION_REVOKED
 * means the session is gone → back to the sign-in screen, not an error text in a form.
 */
const PRE_SESSION = /^\/auth\/(login|mfa)/;

/**
 * admin-bff client. One origin (Caddy proxies /admin/v1/*), the session is the HttpOnly cookie
 * `__Host-tilhero_admin` sent with `credentials: "same-origin"`; nothing secret is stored in the browser.
 * Every non-GET request carries `X-CSRF-Token` = Me.csrf_token (held in memory only).
 */
export class AdminApi {
  private csrf: string | null = null;
  hooks: ClientHooks = {};

  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  setCsrf(token: string | null): void {
    this.csrf = token;
  }

  get hasCsrf(): boolean {
    return !!this.csrf;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const q = qs.toString();
    return `${API_PREFIX}${path}${q ? `?${q}` : ""}`;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }
  patch<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  put<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  /** DELETE with an optional JSON body (news sources: {expected_version, reason}) */
  del<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, { ...opts, body });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const key = opts.idempotencyKey === true ? uuid() : opts.idempotencyKey;
    const res = await this.send(method, path, opts, key);
    if (res.ok) return res.data as T;
    const err = res.error;
    if (err.status === 403 && err.code === "STEP_UP_REQUIRED" && opts.stepUp !== false && this.hooks.onStepUp) {
      const ok = await this.hooks.onStepUp(err);
      if (!ok) {
        err.cancelled = true;
        throw err;
      }
      const again = await this.send(method, path, opts, key);
      if (again.ok) return again.data as T;
      throw again.error;
    }
    throw err;
  }

  /**
   * 409 SESSION_ROTATED: another tab rotated the session id (step-up, password change) — the browser already holds
   * the new cookie, this request carried the old one. Re-read Me (the CSRF token may have changed with the rotation)
   * and repeat the request ONCE with the same Idempotency-Key; a second rotation is reported as an error.
   */
  private async send(method: string, path: string, opts: RequestOptions, key: string | undefined) {
    const res = await this.raw(method, path, opts, key);
    if (res.ok || res.error.status !== 409 || res.error.code !== "SESSION_ROTATED") return res;
    const me = await this.raw("GET", "/me", { background: opts.background }, undefined);
    if (me.ok) {
      const m = me.data as { csrf_token?: unknown } | undefined;
      if (m && typeof m.csrf_token === "string") {
        this.csrf = m.csrf_token;
        this.hooks.onMe?.(m as { csrf_token: string });
      }
    } else if (me.error.status === 401) return me; // the session is gone after all (onSessionLost already fired)
    return this.raw(method, path, opts, key);
  }

  private async raw(
    method: string,
    path: string,
    opts: RequestOptions,
    idemKey: string | undefined,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: ApiError }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}), Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && method !== "HEAD" && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    if (idemKey) headers["Idempotency-Key"] = idemKey;
    if (opts.background) headers["X-Background"] = "1";
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      return { ok: false, error: new ApiError(0, null, "network") };
    }
    if (!opts.background) this.hooks.onServerTouch?.();
    let data: unknown = undefined;
    if (res.status !== 204) {
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
      }
    }
    if (res.ok) return { ok: true, data };
    const error = new ApiError(res.status, (data as Record<string, never>) ?? null);
    rateLimits.note(error, fallbackPolicy(method, path)); // sprint 9 review: the live wait of the screens
    if (res.status === 401 && !PRE_SESSION.test(path) && (SESSION_LOST.has(error.code) || (error.code === "HTTP_401" && !path.startsWith("/auth/")))) {
      this.csrf = null;
      this.hooks.onSessionLost?.(error);
    }
    return { ok: false, error };
  }
}

export const api = new AdminApi();
