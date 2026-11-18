/**
 * Клиенты доменных сервисов admin-bff. Внутренний JWT v2 (EdDSA, kid=iss=admin-bff, aud=<домен>) с контекстом
 * сотрудника `actor {id, role, name, permissions}` — эффективные права из сессии (с учётом имперсонации).
 *
 * Собственная обёртка поверх примитивов ts-common (issueInternalToken, outgoingHeaders, CircuitBreaker), а не
 * ServiceClient: admin-bff нужен HTTP-статус ответа домена (201/202 four-eyes, 200 no-op активации) и таймаут
 * на отдельный вызов (дашборд). См. «Запросы к общему коду» в README.
 *
 * Ошибки:
 *  - 4xx и 501 домена (AUTH_MODE_UNAVAILABLE) → клиенту как есть (статус, код, details) — UpstreamError;
 *  - недоступность, таймаут, прочие 5xx, открытый circuit breaker, битый JSON → 503 UPSTREAM_UNAVAILABLE {service};
 *  - отказ во внутренней авторизации (INTERNAL_TOKEN_*, CALLER_NOT_ALLOWED, ACTOR_NOT_ALLOWED) — ошибка
 *    конфигурации BFF, наружу как 503 (admin-web принял бы 401 за истёкшую сессию);
 *  - осознанный 5xx домена с бизнес-смыслом (например, provider-gateway: «аудит недоступен, состояние не изменено»)
 *    вызывающий маршрут переводит в свой код через `CallOptions.mapServerError`;
 *  - адрес домена не задан (разделы спринта 4 до настройки переменных) → 503 FEATURE_UNAVAILABLE {service}: домен не
 *    вызывается, остальная админка работает.
 */
import {
  AppError,
  CircuitBreaker,
  UpstreamError,
  issueInternalToken,
  outgoingHeaders,
  INTERNAL_HEADER,
  type Actor,
  type KeyRing,
} from "@tilhero/ts-common";

export const SERVICE_NAME = "admin-bff";

export const DOMAIN = {
  adminIdentity: "admin-identity",
  userAdmin: "user-admin",
  identity: "identity-consent",
  support: "support",
  audit: "audit",
  experience: "experience-config",
  sourceRegistry: "source-registry",
  discovery: "discovery",
  providerGateway: "provider-gateway",
  events: "events",
  offers: "offers",
  news: "news",
  watch: "watch",
  aiControl: "ai-control",
  aiConcierge: "ai-concierge",
  opsMonitor: "ops-monitor",
} as const;
export type DomainKey = keyof typeof DOMAIN;

const INTERNAL_AUTH_CODES = new Set([
  "INTERNAL_TOKEN_INVALID",
  "INTERNAL_TOKEN_EXPIRED",
  "INTERNAL_TOKEN_UNKNOWN_ISSUER",
  "CALLER_NOT_ALLOWED",
  "ACTOR_NOT_ALLOWED",
]);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

export type UpstreamLogger = (info: { service: string; status: number; code: string }) => void;

export function upstreamUnavailable(service: string): AppError {
  return new AppError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен, повторите позже", { service });
}

/** Понятный текст для разделов спринта 6 (какой сервис не подключён); прочие — общий «Раздел ещё не настроен». */
const FEATURE_MESSAGES: Readonly<Record<string, string>> = {
  news: "Раздел ещё не настроен: сервис новостей (news) не подключён к админке",
  watch: "Раздел ещё не настроен: сервис слежений (watch) не подключён к админке",
  "ai-control": "Раздел ещё не настроен: сервис учёта и управления AI (ai-control) не подключён к админке",
  "ai-concierge": "Раздел ещё не настроен: сервис AI-консьержа (ai-concierge) не подключён к админке",
  "ops-monitor": "Мониторинг не подключён: сервис ops-monitor не настроен в админке (OPS_MONITOR_URL)",
};

export function featureUnavailable(service: string): AppError {
  return new AppError(503, "FEATURE_UNAVAILABLE", FEATURE_MESSAGES[service] ?? "Раздел ещё не настроен", { service });
}

export interface CallOptions {
  actor?: Actor | undefined;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string | undefined;
  /** Таймаут именно этого вызова (по умолчанию — UPSTREAM_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Повторы (по умолчанию — UPSTREAM_RETRIES, только для безопасных/идемпотентных запросов). */
  retries?: number;
  /** Перевод осознанного 5xx домена (ErrorBody с кодом) в ошибку маршрута; undefined — обычный 503 UPSTREAM_UNAVAILABLE.
   *  Переведённый ответ не повторяется и не считается сбоем для circuit breaker (домен ответил). */
  mapServerError?: (err: UpstreamError) => AppError | undefined;
  /** Отдельный circuit breaker вызова (по имени) вместо общего breaker домена: медленные/сбойные диагностические
   *  вызовы (проверка поставщика, исправление 5.1) не открывают breaker для обычных запросов того же домена. */
  breakerKey?: string;
}

export interface DomainResponse<T> {
  status: number;
  body: T;
  /** спринт 9 (§10): домен ответил `Idempotent-Replayed: true` — повтор команды по тому же Idempotency-Key */
  replayed?: boolean;
}

export interface DomainClientOptions {
  target: string;
  /** null — адрес домена не задан: вызовы → 503 FEATURE_UNAVAILABLE, /health/ready — down. */
  baseUrl: string | null;
  key: KeyRing;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export class DomainClient {
  readonly target: string;
  readonly baseUrl: string;
  readonly configured: boolean;
  private readonly mainBreaker = new CircuitBreaker();
  private readonly isolated = new Map<string, CircuitBreaker>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: DomainClientOptions) {
    this.target = o.target;
    this.configured = Boolean(o.baseUrl);
    this.baseUrl = (o.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private fail(status: number, code: string): AppError {
    this.o.onFailure?.({ service: this.target, status, code });
    return upstreamUnavailable(this.target);
  }

  async call<T = unknown>(method: string, path: string, ro: CallOptions = {}): Promise<DomainResponse<T>> {
    method = method.toUpperCase();
    if (!this.configured) throw featureUnavailable(this.target);
    let breaker = this.mainBreaker;
    if (ro.breakerKey) {
      breaker = this.isolated.get(ro.breakerKey) ?? new CircuitBreaker();
      this.isolated.set(ro.breakerKey, breaker);
    }
    if (!breaker.allow()) throw this.fail(503, "CIRCUIT_OPEN");
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(ro.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const canRetry = IDEMPOTENT.has(method) || Boolean(ro.idempotencyKey);
    const attempts = canRetry ? (ro.retries ?? this.o.retries) + 1 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const headers: Record<string, string> = {
        ...outgoingHeaders(),
        accept: "application/json",
        [INTERNAL_HEADER]: await issueInternalToken(this.o.key, {
          issuer: SERVICE_NAME,
          audience: this.target,
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
          signal: AbortSignal.timeout(ro.timeoutMs ?? this.o.timeoutMs),
        });
      } catch {
        breaker.failure();
        if (attempt < attempts) {
          await sleep(100 * 2 ** (attempt - 1));
          continue;
        }
        throw this.fail(0, "UPSTREAM_UNREACHABLE");
      }
      // 501 — осознанный ответ домена «функция недоступна» (AUTH_MODE_UNAVAILABLE при AUTH_MODE=ad), а не сбой:
      // передаётся клиенту с кодом домена, circuit breaker не трогает.
      if (resp.status === 501) {
        breaker.success();
        const err = await toError(resp, this.target);
        if (err.code === "UPSTREAM_ERROR") throw this.fail(501, "UPSTREAM_501");
        throw err;
      }
      if (resp.status >= 500 && ro.mapServerError) {
        const mapped = ro.mapServerError(await toError(resp, this.target));
        if (mapped) {
          breaker.success();
          throw mapped;
        }
      }
      if (resp.status >= 500) {
        breaker.failure();
        if (attempt < attempts) {
          await sleep(100 * 2 ** (attempt - 1));
          continue;
        }
        throw this.fail(resp.status, "UPSTREAM_5XX");
      }
      breaker.success();
      if (resp.status >= 400) {
        const err = await toError(resp, this.target);
        if (INTERNAL_AUTH_CODES.has(err.code)) throw this.fail(err.status, err.code);
        throw err;
      }
      const replayed = resp.headers.get("idempotent-replayed")?.toLowerCase() === "true";
      if (resp.status === 204) return { status: 204, body: undefined as T, ...(replayed ? { replayed } : {}) };
      try {
        const text = await resp.text();
        return { status: resp.status, body: (text ? JSON.parse(text) : undefined) as T, ...(replayed ? { replayed } : {}) };
      } catch {
        throw this.fail(resp.status, "UPSTREAM_BAD_RESPONSE");
      }
    }
    throw this.fail(0, "UPSTREAM_UNREACHABLE");
  }

  /** /health/ready домена (без внутреннего токена и без circuit breaker): ok | degraded (503) | down. */
  async ready(timeoutMs: number): Promise<{ status: "ok" | "degraded" | "down"; latency_ms: number | null }> {
    if (!this.configured) return { status: "down", latency_ms: null };
    const started = performance.now();
    try {
      const resp = await this.fetchImpl(new URL(`${this.baseUrl}/health/ready`), {
        method: "GET",
        headers: outgoingHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await resp.arrayBuffer().catch(() => undefined);
      const latency = Math.round(performance.now() - started);
      if (resp.status === 200) return { status: "ok", latency_ms: latency };
      if (resp.status === 503) return { status: "degraded", latency_ms: latency };
      return { status: "down", latency_ms: null };
    } catch {
      return { status: "down", latency_ms: null };
    }
  }

  async get<T = unknown>(path: string, ro?: CallOptions): Promise<T> {
    return (await this.call<T>("GET", path, ro)).body;
  }
  async post<T = unknown>(path: string, ro?: CallOptions): Promise<T> {
    return (await this.call<T>("POST", path, ro)).body;
  }
}

async function toError(resp: Response, service: string): Promise<UpstreamError> {
  try {
    const body = (await resp.json()) as { code?: unknown; message?: unknown; details?: unknown };
    const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
    return new UpstreamError(
      resp.status,
      typeof body.code === "string" ? body.code : "UPSTREAM_ERROR",
      typeof body.message === "string" ? body.message : "",
      details as Record<string, unknown>,
      service,
    );
  } catch {
    return new UpstreamError(resp.status, "UPSTREAM_ERROR", `${service} ответил ${resp.status}`, {}, service);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type Domains = Record<DomainKey, DomainClient>;

export interface DomainsOptions {
  key: KeyRing;
  urls: Record<DomainKey, string | null>;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export function createDomains(o: DomainsOptions): Domains {
  const make = (k: DomainKey) =>
    new DomainClient({
      target: DOMAIN[k],
      baseUrl: o.urls[k],
      key: o.key,
      timeoutMs: o.timeoutMs,
      retries: o.retries,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.onFailure ? { onFailure: o.onFailure } : {}),
    });
  return {
    adminIdentity: make("adminIdentity"),
    userAdmin: make("userAdmin"),
    identity: make("identity"),
    support: make("support"),
    audit: make("audit"),
    experience: make("experience"),
    sourceRegistry: make("sourceRegistry"),
    discovery: make("discovery"),
    providerGateway: make("providerGateway"),
    events: make("events"),
    offers: make("offers"),
    news: make("news"),
    watch: make("watch"),
    aiControl: make("aiControl"),
    aiConcierge: make("aiConcierge"),
    opsMonitor: make("opsMonitor"),
  };
}
