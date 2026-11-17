/**
 * Клиенты доменных сервисов. Внутренний JWT v2 (EdDSA, kid=iss=telegram-bff, aud=<домен>, sub=user_id из сессии),
 * проброс trace/correlation id, таймаут, retry идемпотентных запросов, circuit breaker — ServiceClient из ts-common.
 *
 * Ошибки:
 *  - 4xx домена → клиенту как есть (код, статус, details) — UpstreamError;
 *  - недоступность, таймаут, 5xx, открытый circuit breaker → 503 UPSTREAM_UNAVAILABLE {service};
 *  - отказ во внутренней авторизации (INTERNAL_TOKEN_*, CALLER_NOT_ALLOWED) — ошибка конфигурации BFF,
 *    клиенту её 401/403 не отдаём (Mini App принял бы её за истёкшую сессию) → 503.
 */
import {
  AppError,
  ServiceClient,
  UpstreamError,
  type InternalKey,
  type RequestOptions,
  type ServiceClientOptions,
} from "@tilhero/ts-common";

export const SERVICE_NAME = "telegram-bff";

export const DOMAIN = {
  identity: "identity-consent",
  preferences: "preferences",
  support: "support",
  experience: "experience-config",
  /** event-catalog: aud внутреннего JWT = service_name сервиса services/events */
  events: "events",
  /** offers (спринт 5): сборка предложений и снимки (aud = service_name сервиса services/offers) */
  offers: "offers",
  /** спринт 6: ранжирование «Лучшее для вас», реакции (services/recommendations) */
  recommendations: "recommendations",
  /** спринт 6: слежения Watch (services/watch) */
  watch: "watch",
  /** спринт 6: новости (services/news) */
  news: "news",
  /** спринт 7: AI-консьерж (services/ai-concierge) */
  aiConcierge: "ai-concierge",
} as const;

const INTERNAL_AUTH_CODES = new Set(["INTERNAL_TOKEN_INVALID", "INTERNAL_TOKEN_EXPIRED", "CALLER_NOT_ALLOWED"]);

export type UpstreamLogger = (info: { service: string; status: number; code: string }) => void;

export function upstreamUnavailable(service: string): AppError {
  return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service });
}

export class DomainClient extends ServiceClient {
  constructor(
    opts: ServiceClientOptions,
    private readonly onFailure?: UpstreamLogger,
  ) {
    super(opts);
  }

  override async request<T = unknown>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    try {
      return await super.request<T>(method, path, ro);
    } catch (err) {
      throw this.map(err);
    }
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
  preferences: DomainClient;
  support: DomainClient;
  experience: DomainClient;
  events: DomainClient;
  /** offers: сборка предложения (длинный таймаут OFFERS_TIMEOUT_MS). null — OFFERS_URL не задан. */
  offers: DomainClient | null;
  /** offers: чтение снимка (обычный таймаут доменов — обращение в поддержку не ждёт сборки). */
  offersRead: DomainClient | null;
  /** Спринт 6 — необязательные домены: null — URL не задан (секции Home деградируют, эндпоинты → 503 FEATURE_UNAVAILABLE). */
  recommendations: DomainClient | null;
  watch: DomainClient | null;
  /** watch: создание слежения — ответ в конверте {status, body} (201 — создано, 200 — уже было), см. statusEnvelopeFetch. */
  watchCreate: DomainClient | null;
  news: DomainClient | null;
  /** Спринт 7 — ai-concierge (null — AI_CONCIERGE_URL не задан → 503 FEATURE_UNAVAILABLE): чтение (обычный таймаут) */
  ai: DomainClient | null;
  /** ai-concierge: создание переписки и ход без стрима — таймаут CONCIERGE_TIMEOUT_MS, ответ в конверте {status, body} */
  aiLong: DomainClient | null;
}

export interface DomainsOptions {
  /** KeyRing telegram-bff (EdDSA) или dev/test-секрет. */
  key: InternalKey;
  urls: {
    identity: string;
    preferences: string;
    support: string;
    experience: string;
    events: string;
    offers?: string | undefined;
    recommendations?: string | undefined;
    watch?: string | undefined;
    news?: string | undefined;
    aiConcierge?: string | undefined;
  };
  /** Предел размера ответов recommendations/watch/news, байт (недоверенные данные). */
  personalMaxResponseBytes?: number;
  /** Таймаут создания переписки и хода без стрима (CONCIERGE_TIMEOUT_MS). */
  conciergeTimeoutMs?: number;
  timeoutMs: number;
  /** Таймаут сборки предложения (offers). */
  offersTimeoutMs?: number;
  /** Предел размера ответа offers, байт. */
  offersMaxResponseBytes?: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export function createDomains(o: DomainsOptions): Domains {
  const make = (key: keyof typeof DOMAIN, baseUrl: string, extra: Partial<ServiceClientOptions> = {}) =>
    new DomainClient(
      {
        issuer: SERVICE_NAME,
        target: DOMAIN[key],
        baseUrl,
        key: o.key,
        timeoutMs: o.timeoutMs,
        retries: o.retries,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        ...extra,
      },
      o.onFailure,
    );
  const offersUrl = o.urls.offers;
  // Ответ offers — недоверенный и потенциально большой (набор предложений): тело читается с пределом размера.
  const offersFetch = limitedFetch(o.fetchImpl ?? fetch, o.offersMaxResponseBytes ?? 1_048_576);
  const personalFetch = limitedFetch(o.fetchImpl ?? fetch, o.personalMaxResponseBytes ?? 524_288);
  return {
    identity: make("identity", o.urls.identity),
    preferences: make("preferences", o.urls.preferences),
    support: make("support", o.urls.support),
    experience: make("experience", o.urls.experience),
    events: make("events", o.urls.events),
    // сборка — POST без Idempotency-Key: ServiceClient её не повторяет (offers сам идемпотентен по параметрам)
    offers: offersUrl ? make("offers", offersUrl, { fetchImpl: offersFetch, timeoutMs: o.offersTimeoutMs ?? 25_000 }) : null,
    offersRead: offersUrl ? make("offers", offersUrl, { fetchImpl: offersFetch }) : null,
    recommendations: o.urls.recommendations ? make("recommendations", o.urls.recommendations, { fetchImpl: personalFetch }) : null,
    watch: o.urls.watch ? make("watch", o.urls.watch, { fetchImpl: personalFetch }) : null,
    watchCreate: o.urls.watch ? make("watch", o.urls.watch, { fetchImpl: statusEnvelopeFetch(personalFetch) }) : null,
    news: o.urls.news ? make("news", o.urls.news, { fetchImpl: personalFetch }) : null,
    ai: o.urls.aiConcierge ? make("aiConcierge", o.urls.aiConcierge, { fetchImpl: personalFetch }) : null,
    aiLong: o.urls.aiConcierge
      ? make("aiConcierge", o.urls.aiConcierge, { fetchImpl: fullEnvelopeFetch(acceptJson(personalFetch)), timeoutMs: o.conciergeTimeoutMs ?? 75_000, retries: 0 })
      : null,
  };
}

/** Конверт любого ответа (в т. ч. ошибок) {status, body, retry_after}: вызывающий сам разбирает коды ai-concierge
 *  (503 AI_BUSY / AI_PROVIDER_UNAVAILABLE не превращаются в общий UPSTREAM_UNAVAILABLE). Сеть/таймаут — как обычно. */
export function fullEnvelopeFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const resp = await inner(input, init);
    if (resp.status === 204) return new Response(JSON.stringify({ status: 204, body: null }), { status: 200, headers: { "content-type": "application/json" } });
    const text = await resp.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { __invalid_json__: true };
    }
    const ra = resp.headers.get("retry-after");
    return new Response(JSON.stringify({ status: resp.status, body, retry_after: ra }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** Явный `Accept: application/json`: ai-concierge по нему отдаёт ход без стрима (запасной путь, INTERNAL_API §1.2). */
export function acceptJson(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    return inner(input, { ...init, headers });
  };
}

/** Конверт успешного JSON-ответа {status, body}: ServiceClient не отдаёт HTTP-статус, а создание слежения различает
 *  201 (создано) и 200 (слежение за событием уже есть). Ошибки (≥ 400) и 204 — без изменений. */
export function statusEnvelopeFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const resp = await inner(input, init);
    if (resp.status >= 300 || resp.status === 204) return resp;
    const text = await resp.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { __invalid_json__: true };
    }
    return new Response(JSON.stringify({ status: resp.status, body }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** Ответ больше предела — сетевой сбой для ServiceClient (→ 503), тело дальше не читается. */
export class ResponseTooLarge extends TypeError {
  constructor(readonly limit: number) {
    super(`upstream response exceeds ${limit} bytes`);
    this.name = "ResponseTooLarge";
  }
}

/** fetch с пределом размера тела ответа: Content-Length больше предела — сразу отказ, иначе поток читается
 *  до предела (без Content-Length или с ложным значением). */
export function limitedFetch(inner: typeof fetch, maxBytes: number): typeof fetch {
  return async (input, init) => {
    const resp = await inner(input, init);
    const declared = Number(resp.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await resp.body?.cancel().catch(() => undefined);
      throw new ResponseTooLarge(maxBytes);
    }
    if (!resp.body) return resp;
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLarge(maxBytes);
      }
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  };
}
