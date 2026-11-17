/**
 * Клиенты доменных сервисов. Внутренний JWT v2 (EdDSA, kid=iss=telegram-bff, aud=<домен>), проброс trace/correlation
 * id, таймаут, retry идемпотентных запросов, circuit breaker — ServiceClient из ts-common.
 *
 * Субъект внутреннего JWT (INTERNAL_API §9, CONVENTIONS §8):
 *  - учебные домены (learning-plan, центр уведомлений, experience-config for-me/seen/feed) — sub = активный ученик (lrn);
 *  - identity-consent /me/*, social, support — sub = аккаунт Telegram.
 * Какой субъект нужен, решает маршрут (subjects.ts); здесь — только транспорт.
 *
 * Ошибки:
 *  - 4xx домена → клиенту как есть (код, статус, details) — UpstreamError;
 *  - недоступность, таймаут, 5xx, открытый circuit breaker → 503 UPSTREAM_UNAVAILABLE {service};
 *  - отказ во внутренней авторизации (INTERNAL_TOKEN_*, CALLER_NOT_ALLOWED) — ошибка конфигурации BFF,
 *    клиенту её 401/403 не отдаём (Mini App принял бы её за истёкшую сессию) → 503.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AppError,
  ServiceClient,
  UpstreamError,
  type InternalKey,
  type RequestOptions,
  type ServiceClientOptions,
} from "@tilhero/ts-common";

export const SERVICE_NAME = "telegram-bff";

/** aud внутреннего JWT = service_name домена. */
export const DOMAIN = {
  identity: "identity-consent",
  learningPlan: "learning-plan",
  support: "support",
  notifications: "notifications",
  experience: "experience-config",
  social: "social",
} as const;

const INTERNAL_AUTH_CODES = new Set(["INTERNAL_TOKEN_INVALID", "INTERNAL_TOKEN_EXPIRED", "CALLER_NOT_ALLOWED"]);

export type UpstreamLogger = (info: { service: string; status: number; code: string }) => void;

export function upstreamUnavailable(service: string): AppError {
  return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service });
}

/** Дополнительные заголовки запроса к домену (If-Match): RequestOptions ts-common их не поддерживает. */
export interface DomainRequestOptions extends RequestOptions {
  headers?: Record<string, string>;
}

const extraHeaders = new AsyncLocalStorage<Record<string, string>>();

/** fetch, добавляющий заголовки текущего вызова (см. DomainClient.request). Служебные заголовки не перезаписываются. */
function withExtraHeaders(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const extra = extraHeaders.getStore();
    if (!extra) return inner(input, init);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(extra)) if (!headers.has(k)) headers.set(k, v);
    return inner(input, { ...init, headers });
  };
}

export class DomainClient extends ServiceClient {
  constructor(
    opts: ServiceClientOptions,
    private readonly onFailure?: UpstreamLogger,
  ) {
    super({ ...opts, fetchImpl: withExtraHeaders(opts.fetchImpl ?? fetch) });
  }

  override async request<T = unknown>(method: string, path: string, ro: DomainRequestOptions = {}): Promise<T> {
    const { headers, ...rest } = ro;
    try {
      return headers ? await extraHeaders.run(headers, () => super.request<T>(method, path, rest)) : await super.request<T>(method, path, rest);
    } catch (err) {
      throw this.map(err);
    }
  }

  override get<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("GET", path, ro);
  }
  override post<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("POST", path, ro);
  }
  override put<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("PUT", path, ro);
  }
  override patch<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("PATCH", path, ro);
  }
  override delete<T = unknown>(path: string, ro?: DomainRequestOptions) {
    return this.request<T>("DELETE", path, ro);
  }

  private map(err: unknown): Error {
    if (err instanceof UpstreamError || (err instanceof AppError && "service" in err)) {
      const e = err as UpstreamError;
      if (e.status >= 500 || INTERNAL_AUTH_CODES.has(e.code)) {
        this.onFailure?.({ service: this.target, status: e.status, code: e.code });
        return upstreamUnavailable(this.target);
      }
      return e;
    }
    if (err instanceof AppError) return err;
    // JSON.parse ответа и прочие неожиданные сбои — тоже «домен недоступен», без деталей наружу
    this.onFailure?.({ service: this.target, status: 0, code: "UPSTREAM_BAD_RESPONSE" });
    return upstreamUnavailable(this.target);
  }
}

export interface Domains {
  identity: DomainClient;
  learningPlan: DomainClient;
  support: DomainClient;
  notifications: DomainClient;
  experience: DomainClient;
  social: DomainClient;
}

export interface DomainsOptions {
  /** KeyRing telegram-bff (EdDSA) или dev/test-секрет. */
  key: InternalKey;
  urls: Record<keyof Domains, string>;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export function createDomains(o: DomainsOptions): Domains {
  const make = (key: keyof typeof DOMAIN) =>
    new DomainClient(
      {
        issuer: SERVICE_NAME,
        target: DOMAIN[key],
        baseUrl: o.urls[key],
        key: o.key,
        timeoutMs: o.timeoutMs,
        retries: o.retries,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      },
      o.onFailure,
    );
  return {
    identity: make("identity"),
    learningPlan: make("learningPlan"),
    support: make("support"),
    notifications: make("notifications"),
    experience: make("experience"),
    social: make("social"),
  };
}

/** 404 домена → null (например, семьи нет); прочие ошибки — как есть. */
export async function orNull<T>(p: Promise<T>, code: string): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof AppError && err.status === 404 && err.code === code) return null;
    throw err;
  }
}
