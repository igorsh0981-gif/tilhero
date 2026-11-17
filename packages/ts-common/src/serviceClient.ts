/**
 * Клиент доменного сервиса для BFF: внутренний JWT (EdDSA, ключ издателя), проброс trace id, таймаут,
 * retry сетевых сбоев/5xx только для GET/HEAD/OPTIONS или запросов с явным Idempotency-Key (как в Python:
 * PUT/DELETE PIN-операций нельзя повторять вслепую — ревью T4), circuit breaker, ошибки — UpstreamError.
 */
import { AppError } from "./errors.js";
import { outgoingHeaders } from "./context.js";
import { INTERNAL_HEADER, KeyRing, issueInternalToken, type Actor, type InternalKey } from "./internalAuth.js";

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

export class UpstreamError extends AppError {
  constructor(status: number, code: string, message: string, details: Record<string, unknown>, public readonly service: string) {
    super(status, code, message, details);
    this.name = "AppError";
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(private readonly threshold = 5, private readonly cooldownMs = 30_000) {}
  allow(): boolean {
    if (this.openedAt === null) return true;
    return Date.now() - this.openedAt >= this.cooldownMs;
  }
  success(): void {
    this.failures = 0;
    this.openedAt = null;
  }
  failure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }
}

export interface ServiceClientOptions {
  issuer: string;
  target: string;
  baseUrl: string;
  /** KeyRing сервиса (stage/prod) или dev/test-секрет INTERNAL_JWT_SECRET (ключ выводится из него). */
  key?: InternalKey;
  /** @deprecated используйте key (строка — dev-секрет). */
  secret?: string;
  timeoutMs?: number;
  retries?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  subject?: string;
  actor?: Actor;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
}

export class ServiceClient {
  readonly target: string;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly keyRing: KeyRing;

  constructor(private readonly opts: ServiceClientOptions) {
    this.target = opts.target;
    const key = opts.key ?? opts.secret;
    if (!key) throw new Error("ServiceClient: key (KeyRing или dev-секрет) обязателен");
    this.keyRing = typeof key === "string" ? KeyRing.derived(key, opts.issuer) : key;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    if (!this.breaker.allow()) {
      throw new UpstreamError(503, "UPSTREAM_UNAVAILABLE", `${this.target} временно недоступен`, { service: this.target }, this.target);
    }
    const url = new URL(this.opts.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const canRetry = IDEMPOTENT.has(method) || Boolean(ro.idempotencyKey);
    const attempts = canRetry ? (this.opts.retries ?? 2) + 1 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const headers: Record<string, string> = {
        ...outgoingHeaders(),
        [INTERNAL_HEADER]: await issueInternalToken(this.keyRing, {
          issuer: this.opts.issuer,
          audience: this.target,
          ...(ro.subject ? { subject: ro.subject } : {}),
          ...(ro.actor ? { actor: ro.actor } : {}),
        }),
      };
      if (ro.body !== undefined) headers["content-type"] = "application/json";
      if (ro.idempotencyKey) headers["idempotency-key"] = ro.idempotencyKey;

      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          method,
          headers,
          body: ro.body !== undefined ? JSON.stringify(ro.body) : null,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        });
      } catch (err) {
        this.breaker.failure();
        if (attempt < attempts) {
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
        throw new UpstreamError(503, "UPSTREAM_UNAVAILABLE", `${this.target} недоступен`, { service: this.target }, this.target);
      }
      if (resp.status >= 500) {
        this.breaker.failure();
        if (attempt < attempts) {
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
      } else {
        this.breaker.success();
      }
      if (resp.status >= 400) throw await toError(resp, this.target);
      if (resp.status === 204) return undefined as T;
      const text = await resp.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw new UpstreamError(503, "UPSTREAM_UNAVAILABLE", `${this.target} недоступен`, { service: this.target }, this.target);
  }

  get<T = unknown>(path: string, ro?: RequestOptions) { return this.request<T>("GET", path, ro); }
  post<T = unknown>(path: string, ro?: RequestOptions) { return this.request<T>("POST", path, ro); }
  put<T = unknown>(path: string, ro?: RequestOptions) { return this.request<T>("PUT", path, ro); }
  patch<T = unknown>(path: string, ro?: RequestOptions) { return this.request<T>("PATCH", path, ro); }
  delete<T = unknown>(path: string, ro?: RequestOptions) { return this.request<T>("DELETE", path, ro); }
}

async function toError(resp: Response, service: string): Promise<UpstreamError> {
  try {
    const body = (await resp.json()) as { code?: string; message?: string; details?: Record<string, unknown> };
    return new UpstreamError(resp.status, body.code ?? "UPSTREAM_ERROR", body.message ?? "", body.details ?? {}, service);
  } catch {
    return new UpstreamError(resp.status, "UPSTREAM_ERROR", `${service} ответил ${resp.status}`, {}, service);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
