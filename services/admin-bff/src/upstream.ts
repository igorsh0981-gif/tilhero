/**
 * Клиенты доменных сервисов admin-bff. Внутренний JWT v2 (EdDSA, kid=iss=admin-bff, aud=<домен>) с контекстом
 * сотрудника `actor {id, role, name, permissions}` — эффективные права из сессии (с учётом имперсонации).
 *
 * Собственная обёртка поверх примитивов ts-common (issueInternalToken, outgoingHeaders, CircuitBreaker), а не
 * ServiceClient: admin-bff нужен HTTP-статус ответа домена (201/202 four-eyes, 200 no-op публикации и активации),
 * заголовок `Idempotent-Replayed` и таймаут на отдельный вызов (блоки дашборда).
 *
 * Ошибки:
 *  - 4xx домена → клиенту как есть (статус, код, details) — UpstreamError;
 *  - недоступность, таймаут, 5xx, открытый circuit breaker, битый JSON → 503 UPSTREAM_UNAVAILABLE {service};
 *  - отказ во внутренней авторизации (INTERNAL_TOKEN_*, CALLER_NOT_ALLOWED, ACTOR_NOT_ALLOWED) — ошибка
 *    конфигурации BFF, наружу как 503 (admin-web принял бы 401 за истёкшую сессию);
 *  - осознанный 5xx домена с бизнес-смыслом (identity-consent: «аудит недоступен, значение не выдано»)
 *    вызывающий маршрут переводит в свой код через `CallOptions.mapServerError`.
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
import type { DomainUrls } from "./config.js";

export const SERVICE_NAME = "admin-bff";

/** Ключ клиента → имя сервиса (aud внутреннего токена и `service` в 503). */
export const DOMAIN = {
  adminIdentity: "admin-identity",
  userAdmin: "user-admin",
  identity: "identity-consent",
  support: "support",
  audit: "audit",
  experience: "experience-config",
  notifications: "notifications",
  catalog: "catalog",
  diagnostics: "diagnostics",
} as const satisfies Record<keyof DomainUrls, string>;
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
}

/** Двоичный ответ домена (аудио для предпросмотра): байты, тип и ETag как есть — проверяет вызывающий маршрут. */
export interface BinaryBody {
  bytes: Buffer;
  contentType: string;
  etag: string | null;
}

export interface BinaryOptions extends Omit<CallOptions, "body" | "idempotencyKey" | "mapServerError"> {
  /** Больше — ответ испорчен (503), тело дальше не читается. */
  maxBytes: number;
}

export interface DomainResponse<T> {
  status: number;
  body: T;
  /** домен ответил `Idempotent-Replayed: true` — повтор команды по тому же Idempotency-Key */
  replayed?: boolean;
}

export interface DomainClientOptions {
  target: string;
  baseUrl: string;
  key: KeyRing;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export class DomainClient {
  readonly target: string;
  readonly baseUrl: string;
  private readonly breaker = new CircuitBreaker();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: DomainClientOptions) {
    this.target = o.target;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private fail(status: number, code: string): AppError {
    this.o.onFailure?.({ service: this.target, status, code });
    return upstreamUnavailable(this.target);
  }

  async call<T = unknown>(method: string, path: string, ro: CallOptions = {}): Promise<DomainResponse<T>> {
    return this.request<T>(method, path, ro, null);
  }

  /** GET двоичного тела (аудио): те же токен, повторы, circuit breaker и ошибки, что у call(); тело ≤ maxBytes. */
  async binary(path: string, ro: BinaryOptions): Promise<DomainResponse<BinaryBody>> {
    return this.request<BinaryBody>("GET", path, ro, ro.maxBytes);
  }

  private async request<T>(method: string, path: string, ro: CallOptions, binaryMax: number | null): Promise<DomainResponse<T>> {
    method = method.toUpperCase();
    const breaker = this.breaker;
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
        accept: binaryMax === null ? "application/json" : "*/*",
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
      if (resp.status >= 500 && ro.mapServerError) {
        const mapped = ro.mapServerError(await toError(resp, this.target));
        if (mapped) {
          breaker.success();
          throw mapped;
        }
      }
      if (resp.status >= 500) {
        breaker.failure();
        await resp.arrayBuffer().catch(() => undefined);
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
      if (binaryMax !== null) {
        const declared = Number(resp.headers.get("content-length") ?? "0");
        if (declared > binaryMax) {
          await resp.body?.cancel().catch(() => undefined);
          throw this.fail(resp.status, "UPSTREAM_BAD_RESPONSE");
        }
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await resp.arrayBuffer());
        } catch {
          throw this.fail(resp.status, "UPSTREAM_BAD_RESPONSE");
        }
        if (bytes.length > binaryMax) throw this.fail(resp.status, "UPSTREAM_BAD_RESPONSE");
        const body: BinaryBody = { bytes, contentType: resp.headers.get("content-type") ?? "", etag: resp.headers.get("etag") };
        return { status: resp.status, body: body as T };
      }
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

  async get<T = unknown>(path: string, ro?: CallOptions): Promise<T> {
    return (await this.call<T>("GET", path, ro)).body;
  }
  async post<T = unknown>(path: string, ro?: CallOptions): Promise<T> {
    return (await this.call<T>("POST", path, ro)).body;
  }
}

/** Тело ошибки домена → UpstreamError: код и details — только если это ErrorBody (без эха тела наружу). */
async function toError(resp: Response, service: string): Promise<UpstreamError> {
  try {
    const body = (await resp.json()) as { code?: unknown; message?: unknown; details?: unknown };
    const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
    const code = typeof body.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(body.code) ? body.code : "UPSTREAM_ERROR";
    return new UpstreamError(
      resp.status,
      code,
      typeof body.message === "string" ? body.message.slice(0, 500) : "",
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
  urls: DomainUrls;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
  onFailure?: UpstreamLogger;
}

export function createDomains(o: DomainsOptions): Domains {
  const out = {} as Domains;
  for (const k of Object.keys(DOMAIN) as DomainKey[]) {
    out[k] = new DomainClient({
      target: DOMAIN[k],
      baseUrl: o.urls[k],
      key: o.key,
      timeoutMs: o.timeoutMs,
      retries: o.retries,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      ...(o.onFailure ? { onFailure: o.onFailure } : {}),
    });
  }
  return out;
}
