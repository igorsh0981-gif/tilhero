import type { SessionResponse } from "@tilhero/contracts/bff";
import { ApiError, BUSINESS_401 } from "./errors";
import { parseRetryAfter, rateLimits } from "./rateLimit";

export interface ClientHooks {
  /** 423 PIN_REQUIRED: the session is limited until the parent PIN is confirmed → lock screen. */
  onPinRequired?(err: ApiError): void;
  /** Refresh and re-login failed: the user must reopen the Mini App. */
  onSessionLost?(err: ApiError): void;
  /** false on network failure / 502-504, true after the next successful response («Нет связи» banner). */
  onConnectivity?(online: boolean): void;
  /** A new SessionResponse arrived (refresh, re-login, PIN verify) — keep security/consent state in sync. */
  onSession?(s: SessionResponse): void;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** default true: send the bearer token and refresh it on 401 */
  auth?: boolean;
  idempotencyKey?: string;
  /** extra request headers (If-Match for the learning plan) */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** internal: this request is itself a session-issuing call (must not wait for itself) */
  issuing?: boolean;
  /** background request (e.g. «Что нового», unread counter) — its failure never toggles the «Нет связи» banner */
  quiet?: boolean;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RT_KEY = "tilhero.rt";
/** The launch the stored refresh token belongs to: `hash` of that launch's initData (lower case). A reload of the same
 *  launch brings the same initData; a new launch — Telegram Web / Desktop may keep the tab's sessionStorage — brings a
 *  new one, and then the stored session must not be continued (it would skip the parent PIN). */
const RT_LAUNCH_KEY = "tilhero.rt.launch";

function launchId(initData: string | null): string | null {
  if (!initData) return null;
  try {
    const h = new URLSearchParams(initData).get("hash");
    return h ? h.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** sessionStorage may be missing or throw (private mode, sandboxed webviews) — always try/catch. */
function safeStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export interface ClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  storage?: StorageLike | null;
  hooks?: ClientHooks;
  lang?: () => string;
  /** IANA zone of the device → X-Timezone on every request: the BFF creates a default plan in this zone (QA D-03) */
  timezone?: () => string;
  now?: () => number;
}

/**
 * Typed BFF client. The access token lives only in memory; the refresh token in
 * sessionStorage (dies with the Mini App). One refresh at a time (single-flight);
 * on refresh failure the client re-logs in with the still-valid initData.
 */
export class ApiClient {
  private access: string | null = null;
  private accessExp = 0;
  private initData: string | null = null;
  private refreshing: Promise<ApiError | null> | null = null;
  /** Bumped on every accepted session: a refresh that started before a PIN verify must not override it. */
  private generation = 0;
  /** Session-issuing calls in flight (PIN verify, learner switch): proactive refresh waits. */
  private issuing = 0;
  private issuingP: Promise<unknown> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  hooks: ClientHooks;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
    this.hooks = opts.hooks ?? {};
    this.now = opts.now ?? (() => Date.now());
  }

  get authenticated(): boolean {
    return !!this.access;
  }

  /** POST /v1/session/telegram — initData is validated only on the server (APP-AUTH-01). */
  async startSession(initData: string): Promise<SessionResponse> {
    this.initData = initData;
    const s = await this.raw<SessionResponse>("POST", "/v1/session/telegram", { body: { init_data: initData }, auth: false });
    this.acceptSession(s);
    return s;
  }

  /**
   * Boot. initData is one-time on the server (401 INIT_DATA_REPLAYED). A reload of the same launch (Telegram
   * «Reload page», the webview restoring the page) brings the same initData, so the session of this launch is continued
   * with its refresh token (sessionStorage survives a reload). Only when the stored token belongs to this very launch
   * (the same initData `hash`): a new launch in a tab that kept sessionStorage (Telegram Web / Desktop) signs in with
   * its own initData — and asks for the PIN. No token, another launch, or 401 on refresh — a new session from initData.
   */
  resumeSession(initData: string): Promise<SessionResponse> {
    // one boot per initData: a second call (React StrictMode runs the boot effect twice in dev) must not present the
    // one-time initData again — it would get 401 INIT_DATA_REPLAYED and end the session the first call just opened
    if (this.booting && this.booting.initData === initData) return this.booting.p;
    const p = this.doResume(initData);
    this.booting = { initData, p };
    // a failed boot (no network) may be retried by the user: forget it
    p.catch(() => {
      if (this.booting?.p === p) this.booting = null;
    });
    return p;
  }
  private booting: { initData: string; p: Promise<SessionResponse> } | null = null;

  private async doResume(initData: string): Promise<SessionResponse> {
    this.initData = initData;
    const launch = launchId(initData);
    let rt: string | null = null;
    try {
      rt = launch && this.storage?.getItem(RT_LAUNCH_KEY) === launch ? (this.storage?.getItem(RT_KEY) ?? null) : null;
    } catch {
      rt = null;
    }
    if (rt) {
      try {
        const s = await this.raw<SessionResponse>("POST", "/v1/session/refresh", { body: { refresh_token: rt }, auth: false });
        this.acceptSession(s);
        return s;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        try {
          this.storage?.removeItem(RT_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    return this.startSession(initData);
  }

  acceptSession(s: SessionResponse): void {
    // the rotated refresh token goes to storage first: a reload right after rotation must find the new token, not
    // the used one (presenting a used token revokes the whole session)
    try {
      this.storage?.setItem(RT_KEY, s.refresh_token);
      const launch = launchId(this.initData);
      if (launch) this.storage?.setItem(RT_LAUNCH_KEY, launch);
      else this.storage?.removeItem(RT_LAUNCH_KEY);
    } catch {
      /* storage unavailable: refresh falls back to re-login with initData */
    }
    this.generation += 1;
    this.access = s.access_token;
    this.accessExp = this.now() + Math.max(30, s.expires_in) * 1000;
  }

  clear(): void {
    this.access = null;
    this.accessExp = 0;
    try {
      this.storage?.removeItem(RT_KEY);
    } catch {
      /* ignore */
    }
  }

  forgetInitData(): void {
    this.initData = null;
  }

  request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return this.authed(opts, () => this.raw<T>(method, path, opts));
  }

  /** Binary answer (audio of the media library: GET /v1/media/{id}/audio; server speech: POST /v1/speech with a JSON
   *  body) with the same token refresh as JSON calls. */
  blob(path: string, opts: RequestOptions = {}, method: "GET" | "POST" = "GET"): Promise<Blob> {
    return this.authed(opts, async () => (await this.send(method, path, opts, "audio/*")).blob());
  }

  private async authed<T>(opts: RequestOptions, call: () => Promise<T>): Promise<T> {
    const auth = opts.auth !== false;
    // Proactive refresh shortly before expiry. A transient failure here is harmless: the token is still valid.
    if (auth && this.access && !this.issuing && this.now() > this.accessExp - 20_000) await this.refreshOnce().catch(() => null);
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof ApiError) || !auth || e.status !== 401 || BUSINESS_401.has(e.code)) throw e;
      // A PIN verify / learner switch in flight is about to replace the tokens: wait for it instead of refreshing.
      const gen = this.generation;
      if (this.issuingP && !opts.issuing) await this.issuingP.catch(() => null);
      if (this.generation !== gen) return call();
      // Transient refresh failures (network, 5xx, 429) reject here and reach the caller as they are.
      const lost = await this.refreshOnce(e.code === "SESSION_REVOKED");
      if (lost) {
        this.hooks.onSessionLost?.(lost);
        throw lost;
      }
      return call();
    }
  }

  /**
   * Single-flight refresh (the refresh token is one-time: a parallel second refresh would be treated as
   * reuse and revoke the session). Resolves null when a new session is in place, or with the error that
   * ended the session; rejects on transient failures. `revoked` (401 SESSION_REVOKED) skips the refresh
   * token and logs in again with initData.
   */
  refreshOnce(revoked = false): Promise<ApiError | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(revoked).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * Calls that issue a new session (POST /v1/session/pin/verify, POST /v1/session/learner).
   * The BFF reissues tokens and deletes the old refresh token, so they are serialised with refresh: wait for a
   * refresh in flight, block the proactive one meanwhile, and accept the returned session.
   */
  async issueSession(method: string, path: string, opts: RequestOptions = {}): Promise<SessionResponse> {
    if (this.refreshing) await this.refreshing.catch(() => null);
    this.issuing += 1;
    const p = this.request<SessionResponse>(method, path, { ...opts, issuing: true }).then((s) => {
      this.acceptSession(s);
      return s;
    });
    this.issuingP = p;
    try {
      return await p;
    } finally {
      this.issuing -= 1;
      if (this.issuingP === p) this.issuingP = null;
    }
  }

  private async doRefresh(revoked: boolean): Promise<ApiError | null> {
    // A session accepted while this refresh is in flight (PIN verify, learner switch) supersedes it: its 401
    // or its result is stale, and the new refresh token must not be removed.
    const gen = this.generation;
    const superseded = () => this.generation !== gen;
    let lost = new ApiError(401, "REFRESH_INVALID", "no refresh token");
    let rt: string | null = null;
    try {
      rt = revoked ? null : (this.storage?.getItem(RT_KEY) ?? null);
    } catch {
      rt = null;
    }
    if (rt) {
      try {
        const s = await this.raw<SessionResponse>("POST", "/v1/session/refresh", { body: { refresh_token: rt }, auth: false });
        if (superseded()) return null;
        this.acceptSession(s);
        this.hooks.onSession?.(s);
        return null;
      } catch (e) {
        if (superseded()) return null;
        // network / 5xx / 429: keep the token, the next call retries
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        lost = e;
      }
    }
    try {
      this.storage?.removeItem(RT_KEY);
    } catch {
      /* ignore */
    }
    if (!this.initData) return lost;
    try {
      const s = await this.raw<SessionResponse>("POST", "/v1/session/telegram", { body: { init_data: this.initData }, auth: false });
      if (superseded()) return null;
      this.acceptSession(s);
      this.hooks.onSession?.(s);
      return null;
    } catch (e) {
      if (superseded()) return null;
      // 401 INIT_DATA_EXPIRED / 410 USER_DELETED end the session; anything else is transient
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 410)) return e;
      throw e;
    }
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    let u = `${this.opts.baseUrl}${path}`;
    if (query) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
      const s = p.toString();
      if (s) u += `?${s}`;
    }
    return u;
  }

  private async raw<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const res = await this.send(method, path, opts, "application/json");
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** One HTTP call: a successful Response (unread), or ApiError for the error body / the network. */
  private async send(method: string, path: string, opts: RequestOptions, accept: string): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}), Accept: accept };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false && this.access) headers.Authorization = `Bearer ${this.access}`;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const lang = this.opts.lang?.();
    if (lang) headers["Accept-Language"] = lang;
    // the zone matters where the BFF reads a plan (signed-in calls and the session ones); public GETs stay simple
    // requests (no CORS preflight for the policy, the interface config, a guardian link preview)
    const tz = opts.auth !== false || path.startsWith("/v1/session/") ? this.opts.timezone?.() : undefined;
    if (tz) headers["X-Timezone"] = tz;

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
        credentials: "omit",
        cache: "no-store",
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (!opts.quiet) this.hooks.onConnectivity?.(false);
      throw new ApiError(0, "NETWORK", "network error");
    }

    if (res.ok) {
      if (!opts.quiet) this.hooks.onConnectivity?.(true);
      return res;
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    let err = ApiError.fromBody(res.status, body as Record<string, unknown> | null);
    // the wait of a 429 (and a 503 with Retry-After) from the header when the body does not carry it
    if ((res.status === 429 || res.status === 503) && err.retryAfter == null) {
      const ra = parseRetryAfter(res.headers.get("Retry-After"));
      if (ra != null) err = new ApiError(err.status, err.code, err.message, { ...err.details, retry_after: ra }, err.traceId);
    }
    if (err.code === "RATE_LIMITED") rateLimits.note(err);
    // 502–504 → «Нет связи». Exception: a business 503 of the BFF about one domain (UPSTREAM_UNAVAILABLE {service}) —
    // the BFF itself answers, the screen shows its own state with «Повторить», not the global banner.
    if (!opts.quiet) this.hooks.onConnectivity?.(!(res.status >= 502 && res.status <= 504) || REACHABLE_503.has(err.code));
    if (res.status === 423 && err.code === "PIN_REQUIRED") this.hooks.onPinRequired?.(err);
    throw err;
  }
}

/** 503 codes that mean «BFF is reachable, one domain is down» — no connectivity banner. SPEECH_UNAVAILABLE — the
 *  server speech is down, the player falls back to the device voice (tts.ts). */
const REACHABLE_503: ReadonlySet<string> = new Set(["UPSTREAM_UNAVAILABLE", "RATE_LIMIT_UNAVAILABLE", "CATALOG_UNAVAILABLE", "SPEECH_UNAVAILABLE"]);

/** Idempotency-Key for creating commands (one per draft, reused on retries). */
export function newIdempotencyKey(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
